import { afterEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";

type LocationFilter = "HomepageGrid" | "Form" | "SubGrid";
const locations = ["HomepageGrid", "SubGrid", "Form"] as const satisfies readonly LocationFilter[];
const typeName = "Microsoft.Dynamics.CRM.RibbonLocationFilters";

function zipRibbonXml(xml: string): string {
	const compressed = zipSync({ "RibbonXml.xml": strToU8(xml) });
	let binary = "";
	for (const byte of compressed) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function ribbonXml(tabs: Array<{ id: string; commandId: string }>, scope: string): string {
	const tabsXml = tabs.map((tab, index) =>
		`<Tab Id="${tab.id}" Title="${tab.id}" Command="${tab.commandId}" Sequence="${(index + 1) * 10}"><Groups><Group Id="${tab.id}.Group" Title="Actions" Sequence="10"><Controls><Button Id="${tab.id}.Button" LabelText="${scope}" Command="${tab.commandId}" Sequence="10"/></Controls></Group></Groups></Tab>`,
	).join("");
	const commands = [...new Set(tabs.map((tab) => tab.commandId))].map((id) =>
		`<CommandDefinition Id="${id}"><EnableRules><EnableRule Id="publisher.SharedEnableRule"/></EnableRules><DisplayRules/><Actions><Url Address="https://example.test/${id}"/></Actions></CommandDefinition>`,
	).join("");
	return `<RibbonDefinitions><Ribbon><Tabs>${tabsXml}</Tabs></Ribbon><CommandDefinitions>${commands}</CommandDefinitions><RuleDefinitions><EnableRules><EnableRule Id="publisher.SharedEnableRule"><SelectionCountRule Minimum="1"/></EnableRule></EnableRules><DisplayRules/></RuleDefinitions><LocLabels><LocLabel Id="publisher.SharedLabel"><Titles><Title languagecode="1033" description="Shared"/></Titles></LocLabel></LocLabels><Scalings>${tabs.map((tab) => `<Scaling TabId="${tab.id}" Source="${scope}"><MaxSize Id="${tab.id}.Scale" GroupId="${tab.id}.Group" Size="Large" Sequence="10"/></Scaling>`).join("")}</Scalings></RibbonDefinitions>`;
}

const fixtures: Record<LocationFilter, string> = {
	HomepageGrid: ribbonXml([
		{ id: "publisher.account.CustomHomepageTab", commandId: "publisher.HomeCommand" },
		{ id: "publisher.account.SharedAcrossLocations", commandId: "publisher.SharedCommand" },
	], "Home"),
	SubGrid: ribbonXml([
		{ id: "publisher.account.CustomSubGridTab", commandId: "publisher.SubCommand" },
		{ id: "publisher.account.SharedAcrossLocations", commandId: "publisher.SharedCommand" },
	], "SubGrid"),
	Form: ribbonXml([
		{ id: "publisher.account.CustomFormTab", commandId: "publisher.FormCommand" },
	], "Form"),
};

const allXml = ribbonXml([
	{ id: "publisher.account.CustomHomepageTab", commandId: "publisher.HomeCommand" },
	{ id: "publisher.account.CustomSubGridTab", commandId: "publisher.SubCommand" },
	{ id: "publisher.account.CustomFormTab", commandId: "publisher.FormCommand" },
	{ id: "publisher.account.SharedAcrossLocations", commandId: "publisher.SharedCommand" },
], "All");

interface RibbonRequest {
	operationName: string;
	operationType: string;
	parameters?: Record<string, string>;
}

function installFakeApi(onExecute?: (filter: string) => Promise<void>): {
	execute: ReturnType<typeof vi.fn>;
} {
	const execute = vi.fn(async (request: RibbonRequest) => {
		if (request.operationName !== "RetrieveEntityRibbon" || request.operationType !== "function") {
			throw new Error(`Unexpected operation ${request.operationName}`);
		}
		if (request.parameters?.EntityName !== "account") throw new Error("EntityName was not forwarded");
		const filter = request.parameters.RibbonLocationFilter;
		if (typeof filter !== "string") throw new Error("RibbonLocationFilter was not supplied");
		await onExecute?.(filter);
		const name = filter.slice(`${typeName}'`.length, -1);
		const xml = name === "All" ? allXml : fixtures[name as LocationFilter];
		if (!xml) throw new Error(`Unexpected filter ${filter}`);
		return { CompressedEntityXml: zipRibbonXml(xml) };
	});
	(window as unknown as { dataverseAPI: { execute: typeof execute } }).dataverseAPI = { execute };
	return { execute };
}

afterEach(() => {
	vi.resetModules();
	vi.unstubAllGlobals();
});

describe("RetrieveEntityRibbon: authoritative location filtering", () => {
	it("keeps publisher-prefixed Form/SubGrid tabs in the server-requested scope, retaining duplicates across scopes", async () => {
		const { execute } = installFakeApi();
		const { fetchEntityRibbonAllLocations } = await import("@/services/dataverse/ribbonService");
		const result = await fetchEntityRibbonAllLocations("account");

		expect(execute).toHaveBeenCalledTimes(3);
		const checked = execute.mock.calls.map(([request]) => request.parameters?.RibbonLocationFilter);
		expect(new Set(checked)).toEqual(new Set(locations.map((location) => `${typeName}'${location}'`)));
		expect(result.ribbons.Form.tabs.map((tab) => tab.id)).toEqual(["publisher.account.CustomFormTab"]);
		expect(result.ribbons.SubGrid.tabs.map((tab) => tab.id)).toEqual([
			"publisher.account.CustomSubGridTab",
			"publisher.account.SharedAcrossLocations",
		]);
		expect(result.ribbons.HomepageGrid.tabs.map((tab) => tab.id)).toEqual([
			"publisher.account.CustomHomepageTab",
			"publisher.account.SharedAcrossLocations",
		]);
		expect(result.ribbons.Form.scalingByTab?.["publisher.account.CustomFormTab"]?.sourceXml).toContain('Source="Form"');
		expect(result.ribbons.SubGrid.scalingByTab?.["publisher.account.CustomSubGridTab"]?.sourceXml).toContain('Source="SubGrid"');
		expect(result.ribbons.HomepageGrid.scalingByTab?.["publisher.account.CustomHomepageTab"]?.sourceXml).toContain('Source="Home"');
		expect(result.commands.map((command) => command.id).sort()).toEqual([
			"publisher.FormCommand", "publisher.HomeCommand", "publisher.SharedCommand", "publisher.SubCommand",
		]);
		expect(result.enableRules.map((rule) => rule.id)).toEqual(["publisher.SharedEnableRule"]);
		expect(result.locLabels.map((label) => label.id)).toEqual(["publisher.SharedLabel"]);
	});

	it("starts the three scoped reads concurrently without an extra All request", async () => {
		let running = 0;
		let peak = 0;
		const { execute } = installFakeApi(async () => {
			running += 1;
			peak = Math.max(peak, running);
			await new Promise((resolve) => setTimeout(resolve, 5));
			running -= 1;
		});
		const { fetchEntityRibbonAllLocations } = await import("@/services/dataverse/ribbonService");
		await fetchEntityRibbonAllLocations("account");
		expect(peak).toBe(3);
		expect(execute).toHaveBeenCalledTimes(3);
	});

	it("fails if any authoritative location read fails rather than silently reassigning missing tabs", async () => {
		const { execute } = installFakeApi(async (filter) => {
			if (filter === `${typeName}'Form'`) throw new Error("Form filter unavailable");
		});
		const { fetchEntityRibbonAllLocations } = await import("@/services/dataverse/ribbonService");
		await expect(fetchEntityRibbonAllLocations("account")).rejects.toThrow(/Form filter unavailable/);
		expect(execute).toHaveBeenCalledTimes(3);
	});
});
