import { generateRibbonDelta, escapeXml } from "@/services/xmlGenerator";
import { canonicalizeXml, mergeRibbonDiffXml } from "@/services/ribbonMerge";
import { buildRibbonSolutionPackage } from "@/services/ribbonSolutionPackage";
import { rebaseWorkspaceSource } from "@/services/ribbonSourceRebase";
import { hydrateRibbonLabels } from "@/services/hydrateRibbonLabels";
import { assertMergedRibbon, assertStoredRibbon, inspectImportJob, parseVerifiedXml } from "@/services/ribbonVerification";
import { assertActiveOrganization, fetchRibbonSource, normalizedOrganizationUrl } from "./ribbonSourceService";
import { decompressRibbonZip } from "@/utils/decompressRibbonZip";
import { getRuntimeCapabilities } from "@/hosts/runtime";
import { useRuntimeLogStore } from "@/store/runtimeLogStore";
import type { RibbonDelta, RibbonSolutionPackage, RibbonSourceSnapshot, RibbonWorkspace } from "@/types/workspace";

export interface RibbonPublishInput {
	organizationUrl: string;
	solutionUniqueName: string;
	entityLogicalName: string;
	sourceSnapshot: RibbonSourceSnapshot;
	current: RibbonWorkspace;
	baseline: RibbonWorkspace;
	includeApplicationRibbon: boolean;
	solutionVersion?: string;
	formRibbonScope?: "entity" | "form";
	strategy?: "targeted" | "allAsync";
}

export interface PreparedRibbonPublish extends RibbonSolutionPackage {
	input: RibbonPublishInput;
	entityDeltas: RibbonDelta[];
	applicationDeltas: RibbonDelta[];
	changesEntity: boolean;
	changesApplication: boolean;
}

export interface PublishedRibbonResult {
	publishedWorkspace: RibbonWorkspace;
	/** Exact input before verified source-cache rebasing, used to preserve edits made during publication. */
	submittedWorkspace?: RibbonWorkspace;
	sourceSnapshot: RibbonSourceSnapshot;
	backupBase64: string;
	importJobId: string;
}

export interface PublishOptions {
	importTimeoutMs?: number;
	pollIntervalMs?: number;
	verificationAttempts?: number;
	verificationIntervalMs?: number;
	onPrepared?: (prepared: PreparedRibbonPublish) => void;
}

/** The recovery package is retained on every failure after preparation, never automatically imported. */
export class RibbonPublicationError extends Error {
	constructor(message: string, readonly backupBase64?: string, readonly importJobId?: string) {
		super(message);
		this.name = "RibbonPublicationError";
	}
}

let publicationInProgress = false;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function guid(): string {
	if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
	if (typeof crypto?.getRandomValues !== "function") throw new Error("Secure random GUID generation is required before importing.");
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hasChanges(delta: RibbonDelta): boolean {
	if (Object.entries(delta).some(([key, value]) => key !== "xml" && Array.isArray(value) && value.length > 0)) return true;
	const doc = parseVerifiedXml(delta.xml, "Generated ribbon delta");
	return Boolean(doc.querySelector("CustomAction, HideCustomAction, CommandDefinition, RuleDefinitions > EnableRules > EnableRule, RuleDefinitions > DisplayRules > DisplayRule, TabDisplayRule, LocLabel, Scaling"));
}

function validateInput(input: RibbonPublishInput): void {
	const source = input.sourceSnapshot;
	if (!source || !source.organizationUrl || normalizedOrganizationUrl(source.organizationUrl) !== normalizedOrganizationUrl(input.organizationUrl) ||
		source.solutionUniqueName !== input.solutionUniqueName || source.entityLogicalName !== input.entityLogicalName) {
		throw new Error("The loaded source does not match this organization, solution and entity workspace.");
	}
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.entityLogicalName)) throw new Error("Invalid target entity logical name.");
	for (const location of ["HomepageGrid", "SubGrid", "Form"] as const) {
		if (input.current.ribbons[location].entityLogicalName !== input.entityLogicalName || input.baseline.ribbons[location].entityLogicalName !== input.entityLogicalName) {
			throw new Error("The edited ribbon belongs to a different entity workspace. Reload before publishing.");
		}
	}
	const controlIds = (workspace: RibbonWorkspace, application: boolean): Set<string> => {
		const locations = application ? ["Application"] as const : ["HomepageGrid", "SubGrid", "Form"] as const;
		return new Set(locations.flatMap((location) => workspace.ribbons[location].tabs.flatMap((tab) => tab.groups.flatMap((group) => group.buttons.map((button) => button.id)))));
	};
	const beforeEntity = controlIds(input.baseline, false), beforeApplication = controlIds(input.baseline, true);
	const afterEntity = controlIds(input.current, false), afterApplication = controlIds(input.current, true);
	if ([...afterApplication].some((id) => beforeEntity.has(id) && !beforeApplication.has(id)) ||
		[...afterEntity].some((id) => beforeApplication.has(id) && !beforeEntity.has(id))) {
		throw new Error("Transferring existing controls between entity and Application ribbon scopes is not supported by this workspace. Undo the move and author a separately scoped control and command; nothing was imported.");
	}
	if (input.formRibbonScope === "form") {
		throw new Error("Per-systemform ribbon publication is not supported by the entity workspace. Use entity Form ribbon rules instead; no form XML was imported.");
	}
	if (input.strategy === "allAsync" && !getRuntimeCapabilities().publishAllXmlAsync) {
		throw new Error("PublishAllXmlAsync is unavailable in this organization. Use targeted publication.");
	}
	if (!input.includeApplicationRibbon && JSON.stringify(input.current.ribbons.Application) !== JSON.stringify(input.baseline.ribbons.Application)) {
		throw new Error("Application ribbon edits are present. Explicitly include that scope or undo those edits before publishing.");
	}
}

function manifestIdentity(xml: string): string {
	const doc = parseVerifiedXml(xml, "Solution manifest");
	const publisher = doc.querySelector("SolutionManifest > Publisher");
	return `${doc.querySelector("SolutionManifest > UniqueName")?.textContent}|${doc.querySelector("SolutionManifest > Version")?.textContent}|${publisher ? canonicalizeXml(new XMLSerializer().serializeToString(publisher)) : ""}`;
}

function assertNoConflict(loaded: RibbonSourceSnapshot, latest: RibbonSourceSnapshot, includeApplication: boolean): void {
	if (loaded.userId && loaded.userId !== latest.userId) throw new Error("The signed-in CRM user changed. Reload the workspace before publication.");
	if (canonicalizeXml(loaded.entityRibbonXml) !== canonicalizeXml(latest.entityRibbonXml) ||
		(includeApplication && canonicalizeXml(loaded.applicationRibbonXml ?? "<RibbonDiffXml/>") !== canonicalizeXml(latest.applicationRibbonXml ?? "<RibbonDiffXml/>")) ||
		manifestIdentity(loaded.solutionXml) !== manifestIdentity(latest.solutionXml)) {
		throw new Error("The server ribbon, solution version or publisher changed after this workspace loaded. Reload and reconcile the conflict; nothing was imported.");
	}
}

/** Never acknowledge an edited definition that the selected ribbon scopes did not serialize. */
function assertAllDefinitionEditsIncluded(input: RibbonPublishInput, deltas: RibbonDelta[]): void {
	const represented = new Map<string, Set<string>>([
		["commands", new Set()], ["enableRules", new Set()], ["displayRules", new Set()], ["locLabels", new Set()],
	]);
	const selectors = {
		commands: "CommandDefinitions > CommandDefinition", enableRules: "RuleDefinitions > EnableRules > EnableRule",
		displayRules: "RuleDefinitions > DisplayRules > DisplayRule", locLabels: "LocLabels > LocLabel",
	} as const;
	for (const delta of deltas) {
		const doc = parseVerifiedXml(delta.xml, "Generated ribbon delta");
		for (const [kind, selector] of Object.entries(selectors)) {
			for (const element of Array.from(doc.querySelectorAll(selector))) {
				const id = element.getAttribute("Id"); if (id) represented.get(kind)!.add(id);
			}
		}
		for (const [kind, ids] of [["commands", delta.removedCommandIds], ["enableRules", delta.removedEnableRuleIds],
		["displayRules", delta.removedDisplayRuleIds], ["locLabels", delta.removedLocLabelIds]] as const) {
			for (const id of ids) represented.get(kind)!.add(id);
		}
	}
	for (const kind of Object.keys(selectors) as Array<keyof typeof selectors>) {
		const before = new Map(input.baseline[kind].map((item) => [item.id, item]));
		const after = new Map(input.current[kind].map((item) => [item.id, item]));
		for (const id of new Set([...before.keys(), ...after.keys()])) {
			const modelJson = (item: unknown) => JSON.stringify(item, (key, value) => key === "sourceXml" ? undefined : value);
			if (modelJson(before.get(id)) !== modelJson(after.get(id)) && !represented.get(kind)!.has(id)) {
				throw new Error(`Edited ${kind} definition ${id} is unbound or not included in the selected ribbon scopes. Bind it to a control, include its scope, or undo that edit before publishing.`);
			}
		}
	}
}

/** Export, compare, and construct a complete ribbon-only package; this function performs no writes. */
export async function prepareRibbonPublish(input: RibbonPublishInput, onProgress?: (message: string) => void): Promise<PreparedRibbonPublish> {
	const captured = clone(input);
	validateInput(captured);
	await assertActiveOrganization(captured.organizationUrl);
	onProgress?.("Checking the current unmanaged ribbon and publisher for conflicting changes…");
	const latest = await fetchRibbonSource(captured.solutionUniqueName, captured.entityLogicalName, captured.organizationUrl);
	assertNoConflict(captured.sourceSnapshot, latest, captured.includeApplicationRibbon);
	const generate = (location: "HomepageGrid" | "SubGrid" | "Form" | "Application") => generateRibbonDelta({
		current: captured.current.ribbons[location], baseline: captured.baseline.ribbons[location],
		commands: captured.current.commands, displayRules: captured.current.displayRules,
		enableRules: captured.current.enableRules, locLabels: captured.current.locLabels,
		baselineDefinitions: captured.baseline,
		entityLogicalName: location === "Application" ? "{!EntityLogicalName}" : captured.entityLogicalName,
		location,
	});
	const entityDeltas = (["HomepageGrid", "SubGrid", "Form"] as const).map(generate).filter(hasChanges);
	const applicationDelta = generate("Application");
	if (!captured.includeApplicationRibbon && hasChanges(applicationDelta)) {
		throw new Error("Edited definitions also affect the Application ribbon. Explicitly include that scope or use an entity-specific command before publishing.");
	}
	const applicationDeltas = captured.includeApplicationRibbon ? [applicationDelta].filter(hasChanges) : [];
	if (!entityDeltas.length && !applicationDeltas.length) {
		throw new Error("There are no applicable ribbon changes to publish. Bind new commands or rules to a control before publishing them.");
	}
	assertAllDefinitionEditsIncluded(captured, [...entityDeltas, ...applicationDeltas]);
	const entityRibbonXml = entityDeltas.length ? mergeRibbonDiffXml(latest.entityRibbonXml, entityDeltas) : undefined;
	const applicationRibbonXml = applicationDeltas.length ? mergeRibbonDiffXml(latest.applicationRibbonXml ?? "<RibbonDiffXml/>", applicationDeltas) : undefined;
	onProgress?.("Preparing one complete ribbon package and its pre-change recovery package…");
	const packaged = buildRibbonSolutionPackage(latest, { entityRibbonXml, applicationRibbonXml, solutionVersion: captured.solutionVersion });
	return { ...packaged, input: captured, entityDeltas, applicationDeltas, changesEntity: entityDeltas.length > 0, changesApplication: applicationDeltas.length > 0 };
}

/** The documented PublishXml ribbons node targets the application ribbon without publishing everything. */
export function buildTargetedPublishXml(entityLogicalNames: string[], includeApplicationRibbon: boolean): string {
	const names = [...new Set(entityLogicalNames)];
	if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error("Invalid entity in targeted publication.");
	if (!names.length && !includeApplicationRibbon) throw new Error("No publication scope was selected.");
	return `<importexportxml>${names.length ? `<entities>${names.map((name) => `<entity>${escapeXml(name)}</entity>`).join("")}</entities>` : ""}${includeApplicationRibbon ? "<ribbons><ribbon/></ribbons>" : ""}</importexportxml>`;
}

async function waitForImport(importJobId: string, options: PublishOptions): Promise<void> {
	const until = Date.now() + (options.importTimeoutMs ?? 300_000);
	for (; ;) {
		// Read the raw importjob, including its XML result. PPTB convenience wrappers
		// may reshape progress and must not hide a failed component result.
		const status = await window.dataverseAPI.retrieve("importjob", importJobId, ["progress", "completedon", "data"]);
		if (inspectImportJob(status).complete) return;
		if (Date.now() >= until) throw new Error(`Import job ${importJobId} did not finish within the verification deadline. Its outcome is uncertain; do not retry automatically.`);
		await delay(options.pollIntervalMs ?? 1000);
	}
}

async function verifyCompiled(prepared: PreparedRibbonPublish, options: PublishOptions, verifiedSource: RibbonSourceSnapshot): Promise<{ entityXml: string; applicationXml?: string }> {
	const { input } = prepared;
	const attempts = options.verificationAttempts ?? 4;
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			await assertActiveOrganization(input.organizationUrl);
			// The complete entity workspace is also needed to rebase verified caches
			// after an application-only update; never synthesize it from editable XML.
			const result = await window.dataverseAPI.execute({
				operationName: "RetrieveEntityRibbon", operationType: "function", parameters: {
					EntityName: input.entityLogicalName, RibbonLocationFilter: "Microsoft.Dynamics.CRM.RibbonLocationFilters'All'",
				}
			});
			if (typeof result.CompressedEntityXml !== "string") throw new Error("Entity ribbon read-back returned no compressed XML.");
			const entityXml = await decompressRibbonZip(result.CompressedEntityXml);
				assertMergedRibbon(entityXml, prepared.entityDeltas, "Entity", input.sourceSnapshot.entityRibbonXml, verifiedSource.entityRibbonXml);
			let applicationXml: string | undefined;
			if (prepared.changesApplication) {
				const result = await window.dataverseAPI.execute({ operationName: "RetrieveApplicationRibbon", operationType: "function" });
				if (typeof result.CompressedApplicationRibbonXml !== "string") throw new Error("Application ribbon read-back returned no compressed XML.");
				applicationXml = await decompressRibbonZip(result.CompressedApplicationRibbonXml);
					assertMergedRibbon(applicationXml, prepared.applicationDeltas, "Application", input.sourceSnapshot.applicationRibbonXml ?? "<RibbonDiffXml/>", verifiedSource.applicationRibbonXml ?? "<RibbonDiffXml/>");
			}
			await assertActiveOrganization(input.organizationUrl);
			return { entityXml, applicationXml };
		} catch (error) {
			lastError = error;
			if (attempt + 1 < attempts) await delay(options.verificationIntervalMs ?? 2000);
		}
	}
	throw lastError ?? new Error("Compiled ribbon verification did not complete.");
}

/** One coherent import; no per-location overwrites, no automatic rollback, no broad fallback. */
export async function publishRibbonWorkspace(input: RibbonPublishInput, onProgress?: (message: string) => void, options: PublishOptions = {}): Promise<PublishedRibbonResult> {
	if (publicationInProgress) throw new Error("Another ribbon publication is already in progress in this window.");
	publicationInProgress = true;
	let prepared: PreparedRibbonPublish | undefined;
	let importJobId: string | undefined;
	const progress = (message: string) => { useRuntimeLogStore.getState().logInfo("publish", message); onProgress?.(message); };
	try {
		prepared = await prepareRibbonPublish(input, progress);
		options.onPrepared?.(prepared);
		await assertActiveOrganization(prepared.input.organizationUrl);
		importJobId = guid();
		progress(`Importing the complete ribbon package (job ${importJobId})…`);
		await window.dataverseAPI.deploySolution(prepared.base64, { importJobId, overwriteUnmanagedCustomizations: true, publishWorkflows: false });
		await assertActiveOrganization(prepared.input.organizationUrl);
		progress("Inspecting the import job and component results…");
		await waitForImport(importJobId, options);
		await assertActiveOrganization(prepared.input.organizationUrl);
		if (prepared.input.strategy === "allAsync") {
			await publishAllAsync(progress);
		} else {
			progress("Publishing only the requested entity and application-ribbon scopes…");
			await window.dataverseAPI.execute({
				operationName: "PublishXml", operationType: "action", parameters: {
					ParameterXml: buildTargetedPublishXml(prepared.changesEntity ? [prepared.input.entityLogicalName] : [], prepared.changesApplication),
				}
			});
		}
		progress("Reading back the unmanaged source and compiled ribbon before confirming success…");
		const verified = await fetchRibbonSource(prepared.input.solutionUniqueName, prepared.input.entityLogicalName, prepared.input.organizationUrl);
		if (prepared.entityRibbonXml !== undefined) assertStoredRibbon(prepared.entityRibbonXml, verified.entityRibbonXml, "Entity");
		if (prepared.applicationRibbonXml !== undefined) assertStoredRibbon(prepared.applicationRibbonXml, verified.applicationRibbonXml ?? "<RibbonDiffXml/>", "Application");
		const beforePublisher = parseVerifiedXml(prepared.input.sourceSnapshot.solutionXml, "Original manifest").querySelector("SolutionManifest > Publisher");
		const afterPublisher = parseVerifiedXml(verified.solutionXml, "Verified manifest").querySelector("SolutionManifest > Publisher");
		if (!beforePublisher || !afterPublisher || canonicalizeXml(new XMLSerializer().serializeToString(beforePublisher)) !== canonicalizeXml(new XMLSerializer().serializeToString(afterPublisher))) {
			throw new Error("Publisher metadata read-back changed unexpectedly. Keep the recovery package and inspect the solution before proceeding.");
		}
			const compiled = await verifyCompiled(prepared, options, verified);
			const publishedWorkspace = hydrateRibbonLabels(rebaseWorkspaceSource(prepared.input.current, compiled.entityXml, compiled.applicationXml), verified);
		progress("Publication verified: complete unmanaged definition and compiled ribbon read back successfully.");
		return { publishedWorkspace, submittedWorkspace: prepared.input.current, sourceSnapshot: verified, backupBase64: prepared.backupBase64, importJobId };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		useRuntimeLogStore.getState().logError("publish", message);
		throw new RibbonPublicationError(message, prepared?.backupBase64, importJobId);
	} finally {
		publicationInProgress = false;
	}
}

/** Explicitly selected global operation only. Native hosts must positively expose the action. */
export async function publishAllAsync(onProgress?: (message: string) => void, options: { pollIntervalMs?: number; timeoutMs?: number } = {}): Promise<{ asyncOperationId: string; statusCode: number }> {
	if (!getRuntimeCapabilities().publishAllXmlAsync) throw new Error("PublishAllXmlAsync is unavailable in this organization.");
	onProgress?.("Starting the explicitly selected asynchronous publish-all operation…");
	const response = await window.dataverseAPI.execute({ operationName: "PublishAllXmlAsync", operationType: "action" });
	if (typeof response.AsyncOperationId !== "string" || !/^[0-9a-f-]{36}$/i.test(response.AsyncOperationId)) throw new Error("Asynchronous publish returned no valid job ID.");
	const until = Date.now() + (options.timeoutMs ?? 600_000);
	while (Date.now() < until) {
		const job = await window.dataverseAPI.retrieve("asyncoperation", response.AsyncOperationId, ["statecode", "statuscode", "message", "friendlymessage", "completedon"]);
		if (job.statecode === 3 || job.completedon) {
			if (job.statuscode !== 30) throw new Error(`Asynchronous publish failed or could not be verified: ${job.friendlymessage || job.message || job.statuscode}`);
			return { asyncOperationId: response.AsyncOperationId, statusCode: 30 };
		}
		await delay(options.pollIntervalMs ?? 2000);
	}
	throw new Error("Asynchronous publication exceeded its verification deadline. Check the existing job; do not start another automatically.");
}
