import { describe, expect, it } from "vitest";
import { assertMergedRibbon, inspectImportJob } from "@/services/ribbonVerification";
import type { RibbonDelta } from "@/types/workspace";

function delta(xml: string, patch: Partial<RibbonDelta> = {}): RibbonDelta {
	return {
		xml, removedControlIds: [], removedGroupIds: [], removedTabIds: [], unhiddenControlIds: [],
		removedCommandIds: [], removedEnableRuleIds: [], removedDisplayRuleIds: [], removedLocLabelIds: [],
		removedTabDisplayRuleCommands: [], removedScalingTabIds: [], ...patch
	};
}

describe("compiled ribbon semantic verification", () => {
	it("rejects a stale action even when the command ID is present", () => {
		const wanted = '<RibbonDiffXml><CommandDefinitions><CommandDefinition Id="test.Command"><EnableRules/><DisplayRules/><Actions><Url Address="https://example.test/new"/></Actions></CommandDefinition></CommandDefinitions></RibbonDiffXml>';
		const stale = wanted.replace("/new", "/old");
		expect(() => assertMergedRibbon(stale, [delta(wanted)], "Entity")).toThrow(/action|command|verif/i);
	});
	it("rejects a stale rule step even when the rule ID is present", () => {
		const wanted = '<RibbonDiffXml><RuleDefinitions><EnableRules><EnableRule Id="test.Rule"><SelectionCountRule Minimum="2"/></EnableRule></EnableRules></RuleDefinitions></RibbonDiffXml>';
		expect(() => assertMergedRibbon(wanted.replace('Minimum="2"', 'Minimum="1"'), [delta(wanted)], "Entity")).toThrow(/rule|verif/i);
	});
	it("rejects a hide that was not compiled", () => {
		const wanted = '<RibbonDiffXml><CustomActions><HideCustomAction HideActionId="test.Hide" Location="test.Button"/></CustomActions></RibbonDiffXml>';
		expect(() => assertMergedRibbon('<Ribbon><Button Id="test.Button"/></Ribbon>', [delta(wanted)], "Entity")).toThrow(/hide|visib|verif/i);
	});
	it("accepts a hide compiled as control absence or an explicit hide directive", () => {
		const wanted = '<RibbonDiffXml><CustomActions><HideCustomAction HideActionId="test.Hide" Location="test.Button"/></CustomActions></RibbonDiffXml>';
		expect(() => assertMergedRibbon('<Ribbon/>', [delta(wanted)], "Entity")).not.toThrow();
		expect(() => assertMergedRibbon(`<Ribbon><Button Id="test.Button"/>${wanted}</Ribbon>`, [delta(wanted)], "Entity")).not.toThrow();
	});
	it("rejects a removed custom control that remains in the compiled ribbon", () => {
		const original = '<RibbonDiffXml><CustomActions><CustomAction Id="test.Add" Location="test.Group.Controls._children"><CommandUIDefinition><Button Id="test.Button"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>';
		expect(() => assertMergedRibbon('<Ribbon><Button Id="test.Button"/></Ribbon>', [delta('<RibbonDiffXml/>', { removedControlIds: ["test.Button"] })], "Entity", original)).toThrow(/remov|verif/i);
	});
	it("allows an explicitly removed OOB override to reveal its underlying control", () => {
		const original = '<RibbonDiffXml><CustomActions><CustomAction Id="test.Override" Location="Mscrm.Button"><CommandUIDefinition><Button Id="Mscrm.Button"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>';
		expect(() => assertMergedRibbon('<Ribbon><Button Id="Mscrm.Button"/></Ribbon>', [delta('<RibbonDiffXml/>', { removedControlIds: ["Mscrm.Button"] })], "Entity", original)).not.toThrow();
	});
	it("rejects stale localized label content", () => {
		const wanted = '<RibbonDiffXml><LocLabels><LocLabel Id="test.Label"><Titles><Title languagecode="1033" description="Updated"/></Titles></LocLabel></LocLabels></RibbonDiffXml>';
		expect(() => assertMergedRibbon(wanted.replace("Updated", "Old"), [delta(wanted)], "Entity")).toThrow(/label|verif/i);
	});

	it("verifies labels from fresh exported source when native compiled XML omits label declarations", () => {
		const labels = '<RibbonDiffXml><LocLabels><LocLabel Id="test.Label"><Titles><Title languagecode="1033" description="Updated"/></Titles></LocLabel></LocLabels></RibbonDiffXml>';
		expect(() => assertMergedRibbon('<Ribbon/>', [delta(labels)], 'Entity', '<RibbonDiffXml/>', labels)).not.toThrow();
		expect(() => assertMergedRibbon('<Ribbon/>', [delta(labels)], 'Entity', '<RibbonDiffXml/>', labels.replace('Updated', 'Old'))).toThrow(/label|verif/i);
		expect(() => assertMergedRibbon('<Ribbon/>', [delta(labels)], 'Entity')).toThrow(/label|verif/i);
	});
});

describe("import result inspection", () => {
	it("rejects terminal failed jobs and malformed result XML", () => {
		expect(() => inspectImportJob({ progress: 100, completedon: "now", data: '<result result="failure" errortext="Dependency failed"/>' })).toThrow(/Dependency failed/);
		expect(() => inspectImportJob({ progress: 100, data: "<broken>" })).toThrow(/valid XML/);
	});
	it("does not mistake unfinished progress for completion", () => {
		expect(inspectImportJob({ progress: 20 })).toEqual({ complete: false });
		expect(inspectImportJob({ progress: 100, data: '<result result="success"/>' })).toEqual({ complete: true });
	});
	it("rejects terminality without a positive import result", () => {
		expect(() => inspectImportJob({ progress: 100, completedon: "now" })).toThrow(/uncertain|success|result/i);
		expect(() => inspectImportJob({ progress: 100, data: "<importexportxml/>" })).toThrow(/uncertain|success|result/i);
	});
});
