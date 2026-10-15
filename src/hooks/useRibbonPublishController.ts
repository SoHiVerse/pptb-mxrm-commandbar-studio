import { useEffect, useRef, useState } from "react";
import { getRuntimeCapabilities } from "@/hosts/runtime";
import { clearPersistedRibbonData } from "@/hooks/useRibbonPersistence";
import {
	prepareRibbonPublish,
	publishRibbonWorkspace,
	RibbonPublicationError,
	type RibbonPublishInput,
	type PreparedRibbonPublish,
} from "@/services/dataverse/publishService";
import { normalizedOrganizationUrl } from "@/services/dataverse/ribbonSourceService";
import { getBaselineWorkspace, getEditableWorkspace, useRibbonStore } from "@/store/ribbonStore";
import { useSessionStore, type SessionStore } from "@/store/sessionStore";
import { useUIStore } from "@/store/uiStore";
import type { RibbonSourceSnapshot, RibbonWorkspace } from "@/types/workspace";
import { downloadBase64Zip, ribbonPackageFilename } from "@/utils/download";

type Strategy = "targeted" | "allAsync";
export type PublishStatus = "pending" | "publishing" | "success" | "error";
type Outcome = "none" | "verified" | "stale" | "downloaded" | "error";
type Operation = "publish" | "save";

interface RecoveryPackage {
	base64: string;
	solutionUniqueName: string;
	entityLogicalName: string;
	organizationUrl: string;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function nextVersionOf(value: string): string | null {
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(value)) return null;
	const parts = value.split(".").map(Number);
	if (!parts.every((part) => Number.isSafeInteger(part) && part <= 65535) || parts[3] === 65535) return null;
	parts[3] += 1;
	return parts.join(".");
}

/** Editing a definition referenced by the Application ribbon also requires explicit consent. */
function hasApplicationEdits(current: RibbonWorkspace, baseline: RibbonWorkspace): boolean {
	if (JSON.stringify(current.ribbons.Application) !== JSON.stringify(baseline.ribbons.Application)) return true;
	const commandIds = new Set<string>();
	for (const ribbon of [current.ribbons.Application, baseline.ribbons.Application]) {
		for (const tab of ribbon.tabs) {
			if (tab.commandId) commandIds.add(tab.commandId);
			for (const group of tab.groups) {
				for (const button of group.buttons) if (button.commandId) commandIds.add(button.commandId);
			}
		}
	}
	const find = <T extends { id: string }>(items: T[], id: string) => items.find((item) => item.id === id);
	for (const id of commandIds) {
		const before = find(baseline.commands, id);
		const after = find(current.commands, id);
		if (JSON.stringify(before) !== JSON.stringify(after)) return true;
		for (const ruleId of [...(before?.enableRules ?? []), ...(after?.enableRules ?? [])]) {
			if (JSON.stringify(find(baseline.enableRules, ruleId)) !== JSON.stringify(find(current.enableRules, ruleId))) return true;
		}
		for (const ruleId of [...(before?.displayRules ?? []), ...(after?.displayRules ?? [])]) {
			if (JSON.stringify(find(baseline.displayRules, ruleId)) !== JSON.stringify(find(current.displayRules, ruleId))) return true;
		}
	}
	return false;
}

function publicationBlockReason(
	session: SessionStore,
	state: ReturnType<typeof useRibbonStore.getState>,
	includeApplication: boolean,
	strategy: Strategy,
	version: string,
	selectedEntities: string[],
): string | null {
	if (!session.activeSolution) return "Select an unmanaged solution before publishing.";
	if (session.activeSolution.isManaged) return "Choose an unmanaged solution; managed solutions cannot be edited here.";
	if (!session.activeEntity) return "Select a table in the solution before publishing.";
	if (!selectedEntities.includes(session.activeEntity.logicalName)) return "Select the loaded table before continuing.";
	if (selectedEntities.length !== 1) return "Only the loaded table can be published from this workspace.";
	const source = state.sourceSnapshot;
	if (!source?.organizationUrl || state.workspaceReadOnly) {
		return "The unmanaged ribbon source is not available. Reload the source before publishing; the rest of the editor remains available.";
	}
	let expected: string;
	let actual: string;
	try {
		expected = normalizedOrganizationUrl(session.connectionUrl);
		actual = normalizedOrganizationUrl(source.organizationUrl);
	} catch {
		return "The organization or source URL is invalid. Reload the workspace before publishing.";
	}
	if (expected !== actual || source.solutionUniqueName !== session.activeSolution.uniqueName ||
		source.entityLogicalName !== session.activeEntity.logicalName) {
		return "The source does not match this organization, solution or entity. Reload the workspace before publishing.";
	}
	for (const location of ["HomepageGrid", "SubGrid", "Form"] as const) {
		if (state.ribbons[location].entityLogicalName !== source.entityLogicalName ||
			state.baseline[location].entityLogicalName !== source.entityLogicalName) {
			return "The loaded ribbon belongs to another entity. Reload the workspace before publishing.";
		}
	}
	if (session.formRibbonScope === "form") {
		return "Per-systemform publication is unsupported. Select entity-level Form ribbon rules before publishing.";
	}
	const current = getEditableWorkspace(state);
	const baseline = getBaselineWorkspace(state);
	if (hasApplicationEdits(current, baseline) && !includeApplication) {
		return "Application ribbon edits require explicitly selecting Include Application Ribbon.";
	}
	if (includeApplication && !session.solutionRibbonComponentIds?.length) {
		return "This solution does not contain an Application Ribbon root component. Add it and reload the source.";
	}
	if (strategy === "allAsync" && !getRuntimeCapabilities().publishAllXmlAsync) {
		return "PublishAllXmlAsync is unavailable in this organization. Select targeted publication.";
	}
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(version) ||
		version.split(".").some((part) => !Number.isSafeInteger(Number(part)) || Number(part) > 65535)) {
		return "A valid four-part numeric solution version is required.";
	}
	if (state.mutationsSincePublish === 0) return "There are no unsaved ribbon changes in this workspace.";
	return null;
}

function preparedRecovery(input: RibbonPublishInput, base64: string): RecoveryPackage {
	return {
		base64,
		organizationUrl: input.organizationUrl,
		solutionUniqueName: input.solutionUniqueName,
		entityLogicalName: input.entityLogicalName,
	};
}

function matchesCapturedWorkspace(input: RibbonPublishInput, originalSource: RibbonSourceSnapshot, generation: number): boolean {
	const state = useRibbonStore.getState();
	const session = useSessionStore.getState();
	return state.workspaceGeneration === generation && state.sourceSnapshot === originalSource &&
		session.activeEntity?.logicalName === input.entityLogicalName &&
		session.activeSolution?.uniqueName === input.solutionUniqueName &&
		session.connectionUrl.replace(/\/+$/, "") === input.organizationUrl.replace(/\/+$/, "");
}

/**
 * Compatibility logic for the unchanged upstream FluentUI publish dialog.
 * Neither a header button nor a dialog option imports anything until Publish is clicked.
 */
export function useRibbonPublishController() {
	const bulkPublishOpen = useUIStore((s) => s.bulkPublishOpen);
	const closeBulkPublish = useUIStore((s) => s.closeBulkPublish);
	const openXmlDrawer = useUIStore((s) => s.openXmlDrawer);
	const activeSolution = useSessionStore((s) => s.activeSolution);
	const activeEntity = useSessionStore((s) => s.activeEntity);
	const entities = useSessionStore((s) => s.entities);
	const solutionRibbonComponentIds = useSessionStore((s) => s.solutionRibbonComponentIds);
	const formRibbonScope = useSessionStore((s) => s.formRibbonScope);
	const connectionUrl = useSessionStore((s) => s.connectionUrl);
	const ribbons = useRibbonStore((s) => s.ribbons);
	const baseline = useRibbonStore((s) => s.baseline);
	const baselineDefinitions = useRibbonStore((s) => s.baselineDefinitions);
	const commands = useRibbonStore((s) => s.commands);
	const enableRules = useRibbonStore((s) => s.enableRules);
	const displayRules = useRibbonStore((s) => s.displayRules);
	const locLabels = useRibbonStore((s) => s.locLabels);
	const workspaceReadOnly = useRibbonStore((s) => s.workspaceReadOnly);
	const sourceSnapshot = useRibbonStore((s) => s.sourceSnapshot);
	const mutationsSincePublish = useRibbonStore((s) => s.mutationsSincePublish);

	const [selectedEntities, setSelectedEntities] = useState<string[]>(activeEntity ? [activeEntity.logicalName] : []);
	const [includeApplicationRibbon, setIncludeApplicationRibbon] = useState(false);
	const [publishing, setPublishing] = useState(false);
	const workingRef = useRef(false);
	const [statusMap, setStatusMap] = useState<Record<string, PublishStatus>>({});
	const [done, setDone] = useState(false);
	const [incrementSolutionVersion, setIncrementSolutionVersion] = useState(false);
	const [publishStrategy, setPublishStrategy] = useState<Strategy>("targeted");
	const [globalConsent, setGlobalConsent] = useState(false);
	const [progressMessage, setProgressMessage] = useState("");
	const [publishComment, setPublishComment] = useState("");
	const [solutionVersion, setSolutionVersion] = useState(sourceSnapshot?.solutionVersion ?? activeSolution?.version ?? "1.0.0.0");
	const [errorMessages, setErrorMessages] = useState<Array<{ scope: string; message: string }>>([]);
	const [outcome, setOutcome] = useState<Outcome>("none");
	const [recovery, setRecovery] = useState<RecoveryPackage | null>(null);
	const [importJobId, setImportJobId] = useState<string | null>(null);

	const nextVersion = nextVersionOf(solutionVersion) ?? solutionVersion;
	const selectedVersion = incrementSolutionVersion ? nextVersionOf(solutionVersion) ?? "" : solutionVersion;
	const solutionSupportsAppRibbon = !!solutionRibbonComponentIds?.length;
	const supportsAllAsync = getRuntimeCapabilities().publishAllXmlAsync;
	const currentWorkspace: RibbonWorkspace = { ribbons, commands, displayRules, enableRules, locLabels };
	const baselineWorkspace: RibbonWorkspace = { ribbons: baseline, ...baselineDefinitions };
	const applicationEdited = hasApplicationEdits(currentWorkspace, baselineWorkspace);
	const state = useRibbonStore.getState();
	const session: SessionStore = {
		...useSessionStore.getState(), activeSolution, activeEntity, solutionRibbonComponentIds, connectionUrl, formRibbonScope,
	};
	// The live source failure is a publish precondition, not an excuse to replace
	// the rest of the original editor with a warning/empty shell.
	const reason = publicationBlockReason(session, {
		...state,
		ribbons, baseline, baselineDefinitions, commands, enableRules, displayRules, locLabels,
		sourceSnapshot, workspaceReadOnly, mutationsSincePublish,
	}, includeApplicationRibbon, publishStrategy, selectedVersion, selectedEntities);
	const downloadReason = publicationBlockReason(session, {
		...state,
		ribbons, baseline, baselineDefinitions, commands, enableRules, displayRules, locLabels,
		sourceSnapshot, workspaceReadOnly, mutationsSincePublish,
	}, includeApplicationRibbon, "targeted", selectedVersion, selectedEntities);
	const canPublish = !publishing && !reason && (publishStrategy !== "allAsync" || globalConsent);
	const canDownload = !publishing && !downloadReason;

	useEffect(() => {
		if (!bulkPublishOpen || workingRef.current) return;
		setSelectedEntities(activeEntity ? [activeEntity.logicalName] : []);
		setIncludeApplicationRibbon(false);
		setPublishStrategy("targeted");
		setGlobalConsent(false);
		setIncrementSolutionVersion(false);
		setSolutionVersion(sourceSnapshot?.solutionVersion ?? activeSolution?.version ?? "1.0.0.0");
	}, [bulkPublishOpen, activeEntity, activeEntity?.logicalName, activeSolution?.uniqueName, activeSolution?.version,
		sourceSnapshot?.solutionUniqueName, sourceSnapshot?.entityLogicalName, sourceSnapshot?.solutionVersion]);

	const toggleEntity = (logicalName: string) => {
		if (logicalName !== activeEntity?.logicalName) return;
		setSelectedEntities((previous) => previous.includes(logicalName) ? [] : [logicalName]);
	};
	const selectLoadedEntity = () => setSelectedEntities(activeEntity ? [activeEntity.logicalName] : []);
	const deselectAll = () => setSelectedEntities([]);
	const selectStrategy = (value: Strategy) => {
		if (value === "allAsync" && !getRuntimeCapabilities().publishAllXmlAsync) return;
		setPublishStrategy(value);
		setGlobalConsent(false);
	};

	const handlePublish = async (mode: Operation) => {
		if (workingRef.current) return;
		if (mode === "publish" && publishStrategy === "allAsync" && !globalConsent) {
			setErrorMessages([{ scope: "Publish all", message: "Confirm the organization-wide publication before proceeding." }]);
			return;
		}
		const stateAtClick = useRibbonStore.getState();
		const sessionAtClick = useSessionStore.getState();
		const strategy = mode === "save" ? "targeted" : publishStrategy;
		const guard = publicationBlockReason(sessionAtClick, stateAtClick, includeApplicationRibbon, strategy, selectedVersion, selectedEntities);
		if (guard) {
			setErrorMessages([{ scope: "Workspace", message: guard }]);
			return;
		}
		const originalSource = stateAtClick.sourceSnapshot!;
		const generation = stateAtClick.workspaceGeneration;
		const input: RibbonPublishInput = clone({
			organizationUrl: originalSource.organizationUrl!,
			solutionUniqueName: originalSource.solutionUniqueName,
			entityLogicalName: originalSource.entityLogicalName,
			sourceSnapshot: originalSource,
			current: getEditableWorkspace(stateAtClick),
			baseline: getBaselineWorkspace(stateAtClick),
			includeApplicationRibbon,
			solutionVersion: selectedVersion,
			formRibbonScope: sessionAtClick.formRibbonScope,
			strategy,
		});
		const targets = [input.entityLogicalName, ...(includeApplicationRibbon ? ["Application"] : [])];
		const updateStatuses = (status: PublishStatus) =>
			setStatusMap(Object.fromEntries(targets.map((target) => [target, status])));
		workingRef.current = true;
		setPublishing(true);
		setDone(false);
		setOutcome("none");
		setErrorMessages([]);
		setImportJobId(null);
		setProgressMessage(mode === "save" ? "Preparing a local ZIP package (no server writes)…" : "Checking source and preparing a recovery ZIP…");
		updateStatuses("publishing");
		try {
			if (mode === "save") {
				const prepared = await prepareRibbonPublish(input, setProgressMessage);
				setRecovery(preparedRecovery(input, prepared.backupBase64));
				downloadBase64Zip(prepared.base64, ribbonPackageFilename(input.solutionUniqueName, input.entityLogicalName, "prepared"));
				setProgressMessage("ZIP downloaded locally. Nothing was imported or published; your workspace remains unsaved.");
				setOutcome("downloaded");
				updateStatuses("success");
				setDone(true);
				return;
			}
			const result = await publishRibbonWorkspace(input, setProgressMessage, {
				onPrepared: (prepared: PreparedRibbonPublish) => {
					setRecovery(preparedRecovery(input, prepared.backupBase64));
				},
			});
			if (result.backupBase64) setRecovery(preparedRecovery(input, result.backupBase64));
			setImportJobId(result.importJobId);
			if (!matchesCapturedWorkspace(input, originalSource, generation)) {
				setOutcome("stale");
				setProgressMessage("Publication verified on server, but the workspace changed. The new workspace was not reset; reload the original entity to review.");
				updateStatuses("success");
				setDone(true);
				return;
			}
			try {
				useRibbonStore.getState().markPublished(
					result.publishedWorkspace,
					result.sourceSnapshot,
					generation,
					result.submittedWorkspace ?? input.current,
				);
			} catch {
				setOutcome("stale");
				setProgressMessage("Publication verified on server, but the workspace changed; no local state was reset.");
				updateStatuses("success");
				setDone(true);
				return;
			}
			if (useRibbonStore.getState().mutationsSincePublish === 0) {
				clearPersistedRibbonData(input.organizationUrl, input.entityLogicalName, input.solutionUniqueName, input.sourceSnapshot.userId ?? "");
			}
			setOutcome("verified");
			setProgressMessage(useRibbonStore.getState().mutationsSincePublish > 0
				? "Publication verified on server. Later edits remain unsaved in this workspace."
				: "Publication verified on server. The published snapshot is now your baseline.");
			updateStatuses("success");
			setDone(true);
		} catch (error) {
			if (error instanceof RibbonPublicationError) {
				if (error.backupBase64) setRecovery(preparedRecovery(input, error.backupBase64));
				if (error.importJobId) setImportJobId(error.importJobId);
			}
			setErrorMessages([{ scope: input.entityLogicalName, message: error instanceof Error ? error.message : String(error) }]);
			setProgressMessage("The operation did not complete with verification. No local edits were discarded.");
			setOutcome("error");
			updateStatuses("error");
			setDone(false);
		} finally {
			workingRef.current = false;
			if (publishStrategy === "allAsync") setGlobalConsent(false);
			setPublishing(false);
		}
	};

	const handleClose = () => {
		if (workingRef.current) return;
		setStatusMap({});
		setDone(false);
		setProgressMessage("");
		setErrorMessages([]);
		setGlobalConsent(false);
		// Recovery remains pinned to the original solution and entity, including
		// when the user closes this dialog or changes the selected workspace.
		closeBulkPublish();
	};
	const downloadRecovery = () => {
		if (!recovery) return;
		try {
			downloadBase64Zip(recovery.base64, ribbonPackageFilename(recovery.solutionUniqueName, recovery.entityLogicalName, "recovery"));
		} catch (error) {
			setErrorMessages([{ scope: "Recovery ZIP", message: error instanceof Error ? error.message : String(error) }]);
		}
	};

	return {
		bulkPublishOpen, closeBulkPublish, openXmlDrawer,
		activeSolution, activeEntity, entities, selectedEntities, selectLoadedEntity, deselectAll, toggleEntity,
		includeApplicationRibbon, setIncludeApplicationRibbon, solutionSupportsAppRibbon, applicationEdited,
		publishing, statusMap, done, incrementSolutionVersion, setIncrementSolutionVersion,
		publishStrategy, selectStrategy, supportsAllAsync, globalConsent, setGlobalConsent,
		progressMessage, publishComment, setPublishComment, solutionVersion, setSolutionVersion, nextVersion,
		errorMessages, mutationsSincePublish, outcome, recovery, importJobId, downloadRecovery,
		reason, downloadReason, canPublish, canDownload, handlePublish, handleClose,
	};
}
