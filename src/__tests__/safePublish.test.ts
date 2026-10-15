import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRibbonSolution } from "@/services/ribbonSolutionPackage";
import { prepareRibbonPublish, publishRibbonWorkspace, RibbonPublicationError, type RibbonPublishInput } from "@/services/dataverse/publishService";
import type { RibbonWorkspace } from "@/types/workspace";
import { activateOnPremRuntime, activatePptbRuntime } from "@/hosts/runtime";

const ORG = "https://crm.example.test/Org";
const manifest = '<ImportExportXml version="9.1.0.0" SolutionPackageVersion="9.1"><SolutionManifest><UniqueName>TestRibbon</UniqueName><Version>1.0.0.0</Version><Managed>0</Managed><Publisher><UniqueName>testpub</UniqueName><CustomizationPrefix>test</CustomizationPrefix><CustomizationOptionValuePrefix>78123</CustomizationOptionValuePrefix></Publisher><RootComponents><RootComponent type="1" schemaName="account" behavior="2"/></RootComponents></SolutionManifest></ImportExportXml>';
const commandA = '<CommandDefinition Id="test.CommandA"><EnableRules/><DisplayRules/><Actions><Url Address="https://example.test/a"/></Actions></CommandDefinition>';
const original = `<RibbonDiffXml><CustomActions><CustomAction Id="test.OriginalAction" Location="Mscrm.HomepageGrid.account.MainTab.Management.Controls._children" Sequence="10"><CommandUIDefinition><Button Id="test.A" Command="test.CommandA" LabelText="A" Sequence="10" TemplateAlias="o1" CustomAttribute="preserve"/></CommandUIDefinition></CustomAction></CustomActions><Templates/><CommandDefinitions>${commandA}</CommandDefinitions><RuleDefinitions><TabDisplayRules/><DisplayRules/><EnableRules/></RuleDefinitions><LocLabels/></RibbonDiffXml>`;

function base64(bytes: Uint8Array): string { return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")); }
function files(encoded: string) { return unzipSync(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))); }
function exportPackage(xml: string, solutionXml = manifest): string {
	return base64(zipSync({ "solution.xml": strToU8(solutionXml), "customizations.xml": strToU8(`<ImportExportXml><Entities><Entity><Name>account</Name>${xml}</Entity></Entities></ImportExportXml>`), "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') }));
}
function workspace(): RibbonWorkspace {
	return {
		ribbons: {
			HomepageGrid: { location: "HomepageGrid", entityLogicalName: "account", tabs: [{ id: "Mscrm.HomepageGrid.account.MainTab", label: "Home", sequence: 10, tabDisplayRules: [], groups: [{ id: "Mscrm.HomepageGrid.account.MainTab.Management", label: "Manage", sequence: 10, template: "Flexible2", buttons: [{ id: "test.A", label: "A", kind: "button", sequence: 10, templateAlias: "o1", commandId: "test.CommandA", hidden: false, oob: false, custom: true, managed: false }] }] }] },
			SubGrid: { location: "SubGrid", entityLogicalName: "account", tabs: [] },
			Form: { location: "Form", entityLogicalName: "account", tabs: [{ id: "Mscrm.Form.account.MainTab", label: "Form", sequence: 10, tabDisplayRules: [], groups: [{ id: "Mscrm.Form.account.MainTab.Management", label: "Manage", sequence: 10, template: "Flexible2", buttons: [] }] }] },
			Application: { location: "Application", entityLogicalName: "{!EntityLogicalName}", tabs: [] },
		},
		commands: [{ id: "test.CommandA", enableRules: [], displayRules: [], actions: [{ kind: "url", address: "https://example.test/a", passParams: false, params: [] }] }],
		displayRules: [], enableRules: [], locLabels: [],
	};
}

let serverXml: string;
let serverManifest: string;
let input: RibbonPublishInput;
let api: { execute: ReturnType<typeof vi.fn>; retrieve: ReturnType<typeof vi.fn>; queryData: ReturnType<typeof vi.fn>; deploySolution: ReturnType<typeof vi.fn>; getImportJobStatus: ReturnType<typeof vi.fn>; publishCustomizations: ReturnType<typeof vi.fn> };
let failImport: boolean;
let noOpImport: boolean;
let failPublish: boolean;

describe("preservation-aware publication", () => {
	beforeEach(() => {
		serverXml = original; serverManifest = manifest; failImport = false; noOpImport = false; failPublish = false;
		const baseline = workspace(); const current = structuredClone(baseline);
		current.ribbons.Form.tabs[0].groups[0].buttons.push({ id: "test.B", label: "B", kind: "button", sequence: 20, templateAlias: "o1", commandId: "test.CommandB", hidden: false, oob: false, custom: true, managed: false });
		current.commands.push({ id: "test.CommandB", enableRules: [], displayRules: [], actions: [{ kind: "url", address: "https://example.test/b", passParams: false, params: [] }] });
		input = {
			organizationUrl: ORG, solutionUniqueName: "TestRibbon", entityLogicalName: "account", current, baseline,
			sourceSnapshot: { ...parseRibbonSolution(exportPackage(original), "TestRibbon", "account"), organizationUrl: ORG },
			includeApplicationRibbon: false, formRibbonScope: "entity"
		};
		api = {
			execute: vi.fn(async (request: { operationName: string; parameters?: Record<string, unknown> }) => {
				if (request.operationName === "WhoAmI") return { UserId: "test-user" };
				if (request.operationName === "ExportSolution") return { ExportSolutionFile: exportPackage(serverXml, serverManifest) };
				if (request.operationName === "PublishXml") { if (failPublish) throw new Error("Targeted publish denied"); return {}; }
				if (request.operationName === "RetrieveEntityRibbon") return { CompressedEntityXml: base64(zipSync({ "ribbon.xml": strToU8(`<Ribbon>${serverXml}</Ribbon>`) })) };
				if (request.operationName === "RetrieveApplicationRibbon") return { CompressedApplicationRibbonXml: base64(zipSync({ "ribbon.xml": strToU8("<Ribbon/>") })) };
				throw new Error(`Unexpected operation ${request.operationName}`);
			}),
			queryData: vi.fn(async () => ({ progress: 100, completedon: "2026-10-15T00:00:00Z", data: failImport ? '<importexportxml><result result="failure" errorcode="1" errortext="Broken dependency"/></importexportxml>' : '<importexportxml><result result="success"/></importexportxml>' })),
			retrieve: vi.fn(async () => ({ progress: 100, completedon: "2026-10-15T00:00:00Z", data: failImport ? '<importexportxml><result result="failure" errorcode="1" errortext="Broken dependency"/></importexportxml>' : '<importexportxml><result result="success"/></importexportxml>' })),
			getImportJobStatus: vi.fn(async () => ({ progress: 100, completedon: "2026-10-15T00:00:00Z", data: failImport ? '<importexportxml><result result="failure" errorcode="1" errortext="Broken dependency"/></importexportxml>' : '<importexportxml><result result="success"/></importexportxml>' })),
			deploySolution: vi.fn(async (encoded: string) => {
				if (failImport || noOpImport) return {};
				const imported = files(encoded);
				const xml = new DOMParser().parseFromString(strFromU8(imported["customizations.xml"]), "application/xml");
				serverXml = new XMLSerializer().serializeToString(xml.querySelector("Entity > RibbonDiffXml")!);
				serverManifest = strFromU8(imported["solution.xml"]);
				return {};
			}),
			publishCustomizations: vi.fn(async () => { throw new Error("Broad fallback must never be called"); }),
		};
		Object.defineProperty(window, "dataverseAPI", { value: api, writable: true, configurable: true });
		Object.defineProperty(window, "toolboxAPI", { value: { connections: { getActiveConnection: async () => ({ url: ORG }) } }, writable: true, configurable: true });
		activatePptbRuntime();
	});
	afterEach(() => { Reflect.deleteProperty(window, "dataverseAPI"); Reflect.deleteProperty(window, "toolboxAPI"); activatePptbRuntime(); });

	it("performs one narrow import and preserves earlier locations and publisher metadata", async () => {
		const result = await publishRibbonWorkspace(input);
		expect(api.deploySolution).toHaveBeenCalledTimes(1);
		expect(serverXml).toContain('Id="test.A"'); expect(serverXml).toContain('Id="test.B"');
		expect(serverXml).toContain('CustomAttribute="preserve"');
		expect(serverManifest).toContain("<CustomizationOptionValuePrefix>78123</CustomizationOptionValuePrefix>");
		expect(result.sourceSnapshot.entityRibbonXml).toContain('Id="test.B"');
		expect(strFromU8(files(result.backupBase64)["customizations.xml"])).not.toContain('Id="test.B"');
		expect(api.publishCustomizations).not.toHaveBeenCalled();
	});

	it("checks for conflicting source changes before any import", async () => {
		serverXml = original.replace('LabelText="A"', 'LabelText="Other editor"');
		await expect(publishRibbonWorkspace(input)).rejects.toThrow(/changed|conflict/i);
		expect(api.deploySolution).not.toHaveBeenCalled();
	});

	it("rejects a failed import even when progress is 100 and completedon is set", async () => {
		failImport = true;
		await expect(publishRibbonWorkspace(input)).rejects.toThrow(/Broken dependency|import.*fail/i);
		expect(api.execute.mock.calls.some(([r]) => r.operationName === "PublishXml")).toBe(false);
	});

	it("does not turn a failed targeted publish into a broader publication", async () => {
		failPublish = true;
		await expect(publishRibbonWorkspace(input)).rejects.toThrow(/Targeted publish denied/);
		expect(api.publishCustomizations).not.toHaveBeenCalled();
		expect(api.execute.mock.calls.some(([r]) => /^PublishAll/.test(r.operationName))).toBe(false);
	});

	it("does not report a successful-but-no-op import as verified", async () => {
		noOpImport = true;
		await expect(publishRibbonWorkspace(input)).rejects.toThrow(/verif|read.back|did not|match/i);
	});

	it("retains a recovery package after a post-import failure", async () => {
		failPublish = true;
		try { await publishRibbonWorkspace(input); throw new Error("Expected rejection"); }
		catch (error) { expect(error).toBeInstanceOf(RibbonPublicationError); expect((error as RibbonPublicationError).backupBase64).toBeTruthy(); }
	});

	it("prepares a downloadable package without importing or publishing it", async () => {
		const prepared = await prepareRibbonPublish(input);
		expect(prepared.base64).toBeTruthy(); expect(prepared.backupBase64).toBeTruthy();
		expect(api.deploySolution).not.toHaveBeenCalled();
		expect(api.execute.mock.calls.every(([r]) => ["ExportSolution", "WhoAmI"].includes(r.operationName))).toBe(true);
	});

	it("refuses an unresolved per-systemform scope before network writes", async () => {
		await expect(publishRibbonWorkspace({ ...input, formRibbonScope: "form" })).rejects.toThrow(/form|scope/i);
		expect(api.deploySolution).not.toHaveBeenCalled();
	});

	it("refuses an unavailable asynchronous global publish before import", async () => {
		activateOnPremRuntime(false);
		await expect(publishRibbonWorkspace({ ...input, strategy: "allAsync" })).rejects.toThrow(/unavailable|not supported/i);
		expect(api.deploySolution).not.toHaveBeenCalled();
	});

	it("rejects a different active connection before import", async () => {
		window.toolboxAPI.connections.getActiveConnection = async () => ({ url: "https://another.example.test/Org" } as Awaited<ReturnType<ToolBoxAPI.ConnectionsAPI["getActiveConnection"]>>);
		await expect(publishRibbonWorkspace(input)).rejects.toThrow(/connection|organization/i);
		expect(api.deploySolution).not.toHaveBeenCalled();
	});

	it("does not silently acknowledge an orphan command alongside a valid control edit", async () => {
		input.baseline.commands.push({ id: "test.Orphan", enableRules: [], displayRules: [], actions: [{ kind: "url", address: "https://example.test/old", passParams: false, params: [] }] });
		input.current.commands.push({ id: "test.Orphan", enableRules: [], displayRules: [], actions: [{ kind: "url", address: "https://example.test/new", passParams: false, params: [] }] });
		await expect(publishRibbonWorkspace(input)).rejects.toThrow(/orphan|unbound|not represented|not included/i);
		expect(api.deploySolution).not.toHaveBeenCalled();
	});

	it("requires explicit application scope for definitions also changed in that ribbon", async () => {
		input.baseline.ribbons.Application.tabs = structuredClone(input.baseline.ribbons.HomepageGrid.tabs);
		input.current.ribbons.Application.tabs = structuredClone(input.baseline.ribbons.Application.tabs);
		input.current.commands[0].actions = [{ kind: "url", address: "https://example.test/new", passParams: false, params: [] }];
		await expect(publishRibbonWorkspace(input)).rejects.toThrow(/application|scope/i);
		expect(api.deploySolution).not.toHaveBeenCalled();
	});

	it("returns verified source caches so a second definition-only publish does not undo the first", async () => {
		const first = await publishRibbonWorkspace(input);
		const command = first.publishedWorkspace.commands.find((item) => item.id === "test.CommandB")!;
		expect(command.sourceXml).toContain('Address="https://example.test/b"');
		const next = structuredClone(first.publishedWorkspace);
		next.commands.find((item) => item.id === "test.CommandB")!.enableRules = ["test.Enabled"];
		next.enableRules.push({ id: "test.Enabled", steps: [{ kind: "SelectionCountRule", minimum: 1 }] });
		const second = await publishRibbonWorkspace({ ...input, current: next, baseline: first.publishedWorkspace, sourceSnapshot: first.sourceSnapshot });
		expect(second.sourceSnapshot.entityRibbonXml).toContain('Address="https://example.test/b"');
		expect(second.sourceSnapshot.entityRibbonXml).toContain('Id="test.Enabled"');
	});

	it("retains verified labels when native compiled responses omit LocLabels", async () => {
		const execute = api.execute.getMockImplementation()!;
		api.execute.mockImplementation(async (request) => {
			if (request.operationName !== 'RetrieveEntityRibbon') return execute(request);
			const doc = new DOMParser().parseFromString(serverXml, 'application/xml');
			doc.querySelectorAll('LocLabels').forEach((node) => node.remove());
			return { CompressedEntityXml: base64(zipSync({ 'ribbon.xml': strToU8(`<Ribbon>${new XMLSerializer().serializeToString(doc)}</Ribbon>`) })) };
		});
		const result = await publishRibbonWorkspace(input);
		expect(result.publishedWorkspace.locLabels.find((label) => label.id === 'test.B.LabelText')?.titles[0].description).toBe('B');
		expect(api.deploySolution).toHaveBeenCalledTimes(1);
	});

	it("rejects transferring an entity-owned control into the Application scope before writing", async () => {
		const transferred = input.current.ribbons.HomepageGrid.tabs[0].groups[0].buttons.splice(0, 1)[0];
		input.current.ribbons.Application.tabs = [{ id: "test.AppTab", label: "Application", sequence: 10, tabDisplayRules: [], groups: [{ id: "test.AppGroup", label: "Application", sequence: 10, template: "Flexible2", buttons: [transferred] }] }];
		await expect(publishRibbonWorkspace({ ...input, includeApplicationRibbon: true })).rejects.toThrow(/between.*application|cross.scope|transfer/i);
		expect(api.deploySolution).not.toHaveBeenCalled();
	});
});
