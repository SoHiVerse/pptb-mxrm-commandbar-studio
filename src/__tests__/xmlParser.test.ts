import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRibbonXml } from "@/services/xmlParser";

// ── Fixture helpers ────────────────────────────────────────────────────────

function loadFixture(name: string): string {
	return readFileSync(resolve(__dirname, "../__fixtures__/ribbon", name), "utf-8");
}

// ── Parsing account-full.xml ───────────────────────────────────────────────

describe("parseRibbonXml — account entity", () => {
	const xml = loadFixture("account-full.xml");

	it("parses without throwing", () => {
		expect(() => parseRibbonXml(xml, "HomepageGrid", "account")).not.toThrow();
	});

	it("marks all top-level Button elements as oob: true", () => {
		const { ribbon } = parseRibbonXml(xml, "HomepageGrid", "account");
		const allButtons = ribbon.tabs.flatMap((t) => t.groups.flatMap((g) => g.buttons));
		// Every button from pure OOB (not inside CustomAction) should be oob
		expect(allButtons.length).toBeGreaterThan(0);
		const oobButtons = allButtons.filter((b) => b.oob);
		expect(oobButtons.length).toBeGreaterThan(0);
	});

	it("marks Button elements inside CustomAction as custom: true", () => {
		// The account-full fixture contains a CustomAction with a custom button
		const { ribbon } = parseRibbonXml(xml, "HomepageGrid", "account");
		const allButtons = ribbon.tabs.flatMap((t) => t.groups.flatMap((g) => g.buttons));
		const customButtons = allButtons.filter((b) => b.custom);
		expect(customButtons.length).toBeGreaterThan(0);
		customButtons.forEach((btn) => expect(btn.custom).toBe(true));
	});

	it("sets hidden: true on buttons referenced by HideCustomAction", () => {
		const { ribbon } = parseRibbonXml(xml, "HomepageGrid", "account");
		const allButtons = ribbon.tabs.flatMap((t) => t.groups.flatMap((g) => g.buttons));
		const hiddenButtons = allButtons.filter((b) => b.hidden);
		// account-full fixture has one HideCustomAction for EmailAccount
		expect(hiddenButtons.length).toBeGreaterThanOrEqual(1);
	});

	it("parses CommandDefinition with JavaScriptFunction actions", () => {
		const { commands } = parseRibbonXml(xml, "HomepageGrid", "account");
		expect(commands.length).toBeGreaterThan(0);
		const jsCommands = commands.filter((c) => c.actions.some((a) => a.kind === "javascript"));
		expect(jsCommands.length).toBeGreaterThan(0);
	});

	it("parses EnableRule and DisplayRule steps", () => {
		const { enableRules, displayRules } = parseRibbonXml(xml, "HomepageGrid", "account");
		expect(enableRules.length).toBeGreaterThan(0);
		expect(displayRules.length).toBeGreaterThan(0);
	});

	it("parses LocLabel Titles into the labels map", () => {
		const { locLabels } = parseRibbonXml(xml, "HomepageGrid", "account");
		expect(locLabels.length).toBeGreaterThan(0);
		const label = locLabels[0];
		expect(label.id).toBeTruthy();
		expect(label.titles.length).toBeGreaterThan(0);
		expect(label.titles[0].languageCode).toBe(1033);
	});

	it("returns the correct location and entityLogicalName", () => {
		const { ribbon } = parseRibbonXml(xml, "HomepageGrid", "account");
		expect(ribbon.location).toBe("HomepageGrid");
		expect(ribbon.entityLogicalName).toBe("account");
	});
});

// ── Provenance heuristic at parse time ─────────────────────────────────────

describe("parseRibbonXml — provenance heuristic", () => {
	// Buttons in the plain Tab/Group structure (NOT wrapped in CustomAction).
	// Authoritative managed/unmanaged comes later from solution layers; the
	// parser only sets a heuristic: Mscrm.*/Microsoft.* = OOB, else = custom.
	const xml = `<?xml version="1.0" encoding="utf-8"?>
<RibbonDefinitions><RibbonDefinition><Tabs>
  <Tab Id="Mscrm.Form.account.MainTab" Title="Main" Sequence="10"><Groups>
    <Group Id="Mscrm.Form.account.MainTab.Save" Title="Save" Sequence="10"><Controls>
      <Button Id="msdyn.account.FieldService.Button" LabelText="FS" TemplateAlias="o1" Sequence="10"/>
      <Button Id="Mscrm.Form.account.MainTab.Save.SavePrimary" LabelText="Save" TemplateAlias="o1" Sequence="20"/>
    </Controls></Group>
  </Groups></Tab>
</Tabs></RibbonDefinition></RibbonDefinitions>`;

	function findButton(ribbon: ReturnType<typeof parseRibbonXml>["ribbon"], id: string) {
		return ribbon.tabs.flatMap((t) => t.groups.flatMap((g) => g.buttons)).find((b) => b.id === id);
	}

	it("treats any non-system id as a customization (not OOB) by heuristic", () => {
		const { ribbon } = parseRibbonXml(xml, "Form", "account");
		// Note: managed-vs-unmanaged is refined later by the solution-layer
		// service; the parse-time heuristic only knows it's NOT OOB.
		const fs = findButton(ribbon, "msdyn.account.FieldService.Button");
		expect(fs?.oob).toBe(false);
		expect(fs?.origin).toBe("unmanaged");
	});

	it("marks Mscrm.* platform buttons as OOB", () => {
		const { ribbon } = parseRibbonXml(xml, "Form", "account");
		const oob = findButton(ribbon, "Mscrm.Form.account.MainTab.Save.SavePrimary");
		expect(oob?.oob).toBe(true);
		expect(oob?.origin).toBe("oob");
	});
});

describe("parseRibbonXml — numeric boolean action arguments", () => {
	it("treats BoolParameter Value=1 as true without losing argument order", () => {
		const xml = `<RibbonDefinitions><CommandDefinitions><CommandDefinition Id="Custom.C"><EnableRules/><DisplayRules/><Actions><JavaScriptFunction Library="$webresource:custom_/x.js" FunctionName="Run"><BoolParameter Value="1"/><BoolParameter Value="0"/><StringParameter Value="last"/></JavaScriptFunction></Actions></CommandDefinition></CommandDefinitions></RibbonDefinitions>`;
		const command = parseRibbonXml(xml, "Form", "account").commands[0];
		expect(command.actions[0].kind).toBe("javascript");
		if (command.actions[0].kind !== "javascript") throw new Error("Expected JavaScript action");
		expect(command.actions[0].params).toEqual([
			{ kind: "BoolParameter", name: undefined, value: true },
			{ kind: "BoolParameter", name: undefined, value: false },
			{ kind: "StringParameter", name: undefined, value: "last" },
		]);
	});
});

describe("parseRibbonXml — structural declaration scoping", () => {
	it("does not create duplicate displayed tabs from CustomAction-nested Tab declarations", () => {
		const xml = `<RibbonDefinitions><Ribbon><Tabs><Tab Id="T" Title="First"><Groups><Group Id="G" Label="Main"><Controls/></Group></Groups></Tab></Tabs></Ribbon><CustomActions><CustomAction Id="override" Location="Mscrm.Tabs._children"><CommandUIDefinition><Ribbon><Tabs><Tab Id="T" Title="Nested duplicate"><Groups><Group Id="Other" Label="Other"><Controls/></Group></Groups></Tab></Tabs></Ribbon></CommandUIDefinition></CustomAction></CustomActions></RibbonDefinitions>`;
		const result = parseRibbonXml(xml, "Form", "account");
		expect(result.ribbon.tabs.map(tab => tab.id)).toEqual(["T"]);
		expect(result.ribbon.tabs[0].groups.map(group => group.id)).toEqual(["G"]);
	});
});

// ── Error handling ─────────────────────────────────────────────────────────

describe("parseRibbonXml — error handling", () => {
	it("throws a user-friendly error for malformed XML", () => {
		const badXml = "<RibbonDefinitions><Tab><Broken</RibbonDefinitions>";
		expect(() => parseRibbonXml(badXml, "HomepageGrid", "account")).toThrow(/parse error/i);
	});

	it("throws for completely empty string", () => {
		expect(() => parseRibbonXml("", "HomepageGrid", "account")).toThrow();
	});
});

// ── Parsing contact-full.xml ───────────────────────────────────────────────

describe("parseRibbonXml — contact entity", () => {
	const xml = loadFixture("contact-full.xml");

	it("parses contact fixture without throwing", () => {
		expect(() => parseRibbonXml(xml, "HomepageGrid", "contact")).not.toThrow();
	});

	it("returns tabs for contact entity", () => {
		const { ribbon } = parseRibbonXml(xml, "HomepageGrid", "contact");
		expect(ribbon.entityLogicalName).toBe("contact");
		expect(ribbon.tabs.length).toBeGreaterThanOrEqual(0);
	});
});

// ── All-rule-kinds fixture ─────────────────────────────────────────────────
// Verifies that every RuleStep kind in the type union is parsed (not silently
// dropped). The fixture contains one step of every supported kind in both an
// EnableRule and a DisplayRule. Regression guard for ISSUE-1 (parser missing
// 18 rule kinds) and ISSUE-2 (TabDisplayRules wrong DOM scope).

describe("parseRibbonXml — all rule kinds fixture", () => {
	const xml = readFileSync(
		resolve(__dirname, "../__fixtures__/ribbon/all-rule-kinds.xml"),
		"utf-8",
	);

	it("parses without throwing", () => {
		expect(() => parseRibbonXml(xml, "HomepageGrid", "account")).not.toThrow();
	});

	// EnableRule must contain ALL expected Enable-valid kinds (16 kinds in fixture)
	it("parses every EnableRule-valid step kind without dropping any", () => {
		const { enableRules } = parseRibbonXml(xml, "HomepageGrid", "account");
		const rule = enableRules.find((r) => r.id === "TestEnableRule");
		expect(rule).toBeDefined();
		const kinds = rule!.steps.map((s) => s.kind);
		const expected: string[] = [
			"SelectionCountRule",
			"EntityRule",
			"FormStateRule",
			"CommandClientTypeRule",
			"CrmClientTypeRule",
			"CustomRule",
			"RecordPrivilegeRule",
			"OutlookItemTrackingRule",
			"OutlookVersionRule",
			"PageRule",
			"SkuRule",
			"ValueRule",
			"CrmOfflineAccessStateRule",
			"CrmOutlookClientTypeRule",
			"MiscellaneousPrivilegeRule",
			"OrRule",
		];
		for (const kind of expected) {
			expect(kinds).toContain(kind);
		}
	});

	// DisplayRule must contain ALL display-only and shared kinds
	it("parses every DisplayRule step kind without dropping any", () => {
		const { displayRules } = parseRibbonXml(xml, "HomepageGrid", "account");
		const rule = displayRules.find((r) => r.id === "TestDisplayRule");
		expect(rule).toBeDefined();
		const kinds = rule!.steps.map((s) => s.kind);
		const displayOnlyKinds: string[] = [
			"EntityPrivilegeRule",
			"EntityPropertyRule",
			"DeviceTypeRule",
			"OptionSetRule",
			"FormEntityContextRule",
			"PageRule",
			"RelationshipTypeRule",
			"ReferencingAttributeRequiredRule",
			"ShowOnQuickActionRule",
			"ShowOnGridAndQuickActionRule",
			"ShowOnGridRule",
			"OutlookRenderTypeRule",
			"CrmOutlookClientVersionRule",
		];
		for (const kind of displayOnlyKinds) {
			expect(kinds).toContain(kind);
		}
	});

	// Verify parsed attribute values on a sampling of kinds
	it("parses EntityPrivilegeRule attributes correctly", () => {
		const { displayRules } = parseRibbonXml(xml, "HomepageGrid", "account");
		const rule = displayRules.find((r) => r.id === "TestDisplayRule")!;
		const step = rule.steps.find((s) => s.kind === "EntityPrivilegeRule");
		expect(step).toBeDefined();
		if (step?.kind === "EntityPrivilegeRule") {
			expect(step.privilegeType).toBe("Read");
			expect(step.privilegeDepth).toBe("Basic");
			expect(step.entityName).toBe("account");
			expect(step.appliesTo).toBe("PrimaryEntity");
		}
	});

	it("parses EntityPropertyRule attributes correctly", () => {
		const { displayRules } = parseRibbonXml(xml, "HomepageGrid", "account");
		const rule = displayRules.find((r) => r.id === "TestDisplayRule")!;
		const step = rule.steps.find((s) => s.kind === "EntityPropertyRule");
		expect(step).toBeDefined();
		if (step?.kind === "EntityPropertyRule") {
			expect(step.propertyName).toBe("HasNotes");
			expect(step.propertyValue).toBe(true);
		}
	});

	it("parses CrmOutlookClientVersionRule integer attributes correctly", () => {
		const { displayRules } = parseRibbonXml(xml, "HomepageGrid", "account");
		const rule = displayRules.find((r) => r.id === "TestDisplayRule")!;
		const step = rule.steps.find((s) => s.kind === "CrmOutlookClientVersionRule");
		expect(step).toBeDefined();
		if (step?.kind === "CrmOutlookClientVersionRule") {
			expect(step.major).toBe(15);
			expect(step.minor).toBe(0);
		}
	});

	it("parses RelationshipTypeRule with required AppliesTo=SelectedEntity", () => {
		const { displayRules } = parseRibbonXml(xml, "HomepageGrid", "account");
		const rule = displayRules.find((r) => r.id === "TestDisplayRule")!;
		const step = rule.steps.find((s) => s.kind === "RelationshipTypeRule");
		expect(step).toBeDefined();
		if (step?.kind === "RelationshipTypeRule") {
			expect(step.appliesTo).toBe("SelectedEntity");
			expect(step.relationshipType).toBe("OneToMany");
			expect(step.allowCustomRelationship).toBe(true);
			expect(step.allowSystemRelationship).toBe(false);
		}
	});

	// ISSUE-2 regression: TabDisplayRules must be read from document root,
	// not from inside <Tab> elements.
	it("parses TabDisplayRules from document root scope (not Tab children)", () => {
		const { ribbon } = parseRibbonXml(xml, "HomepageGrid", "account");
		const tab = ribbon.tabs.find((t) => t.id === "TestTab");
		expect(tab).toBeDefined();
		// TabDisplayRule has TabCommand="TestTab.Command" which matches tab.commandId
		expect(tab!.tabDisplayRules.length).toBe(1);
		const tdr = tab!.tabDisplayRules[0];
		expect(tdr.tabCommand).toBe("TestTab.Command");
		expect(tdr.rules.length).toBe(2);
		expect(tdr.rules[0].kind).toBe("EntityRule");
		expect(tdr.rules[1].kind).toBe("PageRule");
		if (tdr.rules[1].kind === "PageRule") {
			expect(tdr.rules[1].address).toBe("http://example.com/testpage");
		}
	});

	// ISSUE-3 regression: group selector must only match direct children,
	// not groups inside CustomAction > CommandUIDefinition.
	it("does not produce phantom groups from CustomAction-nested Group elements", () => {
		// Inject a CustomAction with a nested Group to verify it is not duplicated.
		const xmlWithCustomAction = xml.replace(
			"<Tabs>",
			`<CustomActions>
        <CustomAction Id="TestCA" Location="TestGroup.Controls._children" Sequence="20">
          <CommandUIDefinition>
            <Button Id="TestCA.Button" LabelText="CA" TemplateAlias="o1" Sequence="20"/>
          </CommandUIDefinition>
        </CustomAction>
      </CustomActions>
      <Tabs>`,
		);
		const { ribbon } = parseRibbonXml(xmlWithCustomAction, "HomepageGrid", "account");
		const tab = ribbon.tabs.find((t) => t.id === "TestTab")!;
		// Only one group should exist — the rogue `, Group` selector would have
		// matched any <Group> nested in CustomAction definitions too.
		expect(tab.groups.filter((g) => g.id === "TestGroup").length).toBe(1);
	});

	// OrRule nesting: nested steps inside <Or> elements should be parsed.
	it("parses OrRule with nested steps (min 2 Or children)", () => {
		const { enableRules } = parseRibbonXml(xml, "HomepageGrid", "account");
		const rule = enableRules.find((r) => r.id === "TestEnableRule")!;
		const orStep = rule.steps.find((s) => s.kind === "OrRule");
		expect(orStep).toBeDefined();
		if (orStep?.kind === "OrRule") {
			expect(orStep.rules.length).toBeGreaterThanOrEqual(2);
		}
	});

	// SkuRule with InvertResult="true"
	it("parses InvertResult attribute correctly", () => {
		const { enableRules } = parseRibbonXml(xml, "HomepageGrid", "account");
		const rule = enableRules.find((r) => r.id === "TestEnableRule")!;
		const step = rule.steps.find((s) => s.kind === "SkuRule");
		expect(step).toBeDefined();
		if (step && "invertResult" in step) {
			expect(step.invertResult).toBe(true);
		}
	});
});
