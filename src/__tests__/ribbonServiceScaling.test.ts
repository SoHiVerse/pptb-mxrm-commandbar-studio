import { describe, expect, it } from "vitest";
import { splitTabsByLocation } from "@/services/dataverse/ribbonService";
import type { RibbonDefinition, RibbonTab } from "@/types/ribbon";

function tab(id: string): RibbonTab {
	return { id, label: id, sequence: 10, groups: [], tabDisplayRules: [] };
}

describe("splitTabsByLocation scaling ownership", () => {
	it("retains only each location's parsed scalingByTab entries", () => {
		const input: RibbonDefinition = {
			location: "HomepageGrid", entityLogicalName: "account",
			tabs: [
				tab("Mscrm.HomepageGrid.account.MainTab"),
				tab("Mscrm.Form.account.MainTab"),
				tab("Mscrm.SubGrid.account.MainTab"),
			],
			scalingByTab: {
				"Mscrm.HomepageGrid.account.MainTab": { tabId: "Mscrm.HomepageGrid.account.MainTab", maxSizes: [{ id: "home.scale", groupId: "H", size: "Large", sequence: 10 }], scales: [] },
				"Mscrm.Form.account.MainTab": { tabId: "Mscrm.Form.account.MainTab", maxSizes: [], scales: [{ id: "form.scale", groupId: "F", size: "Medium", sequence: 10 }], sourceXml: '<Scaling TabId="Mscrm.Form.account.MainTab" Keep="raw"/>' },
				"Mscrm.SubGrid.account.MainTab": { tabId: "Mscrm.SubGrid.account.MainTab", maxSizes: [], scales: [] },
				"absent.Tab": { tabId: "absent.Tab", maxSizes: [], scales: [] },
			},
		};
		const result = splitTabsByLocation(input, "account");
		expect(Object.keys(result.HomepageGrid.scalingByTab ?? {})).toEqual(["Mscrm.HomepageGrid.account.MainTab"]);
		expect(Object.keys(result.Form.scalingByTab ?? {})).toEqual(["Mscrm.Form.account.MainTab"]);
		expect(Object.keys(result.SubGrid.scalingByTab ?? {})).toEqual(["Mscrm.SubGrid.account.MainTab"]);
		expect(result.Form.scalingByTab?.["Mscrm.Form.account.MainTab"].sourceXml).toContain('Keep="raw"');
		expect(input.scalingByTab).toHaveProperty("absent.Tab");
	});

	it("does not create synthetic scaling entries for a location without any parsed scalings", () => {
		const input: RibbonDefinition = {
			location: "HomepageGrid", entityLogicalName: "account",
			tabs: [tab("Mscrm.HomepageGrid.account.MainTab"), tab("Mscrm.Form.account.MainTab")],
			scalingByTab: { "Mscrm.Form.account.MainTab": { tabId: "Mscrm.Form.account.MainTab", maxSizes: [], scales: [] } },
		};
		const split = splitTabsByLocation(input, "account");
		expect(split.HomepageGrid.scalingByTab).toBeUndefined();
		expect(split.Form.scalingByTab?.["Mscrm.Form.account.MainTab"]).toEqual(input.scalingByTab?.["Mscrm.Form.account.MainTab"]);
	});
});
