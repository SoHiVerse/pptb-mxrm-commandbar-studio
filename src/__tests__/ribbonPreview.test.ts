import { describe, expect, it } from "vitest";
import { buildRibbonPreview } from "@/services/ribbonPreview";
import type { RibbonSourceSnapshot, RibbonWorkspace } from "@/types/workspace";
import type { RibbonButton, RibbonDefinition, RibbonLocation } from "@/types/ribbon";

const sourceEntity = `<RibbonDiffXml Vendor="preserve">
  <CustomActions>
    <CustomAction Id="Home.Group.Action" Location="Tab.Home.Groups._children" Sequence="10">
      <CommandUIDefinition><Group Id="Group.Home" Title="Home" Template="Mscrm.Templates.Flexible2" Sequence="10"><Controls /></Group></CommandUIDefinition>
    </CustomAction>
    <CustomAction Id="Form.Group.Action" Location="Tab.Form.Groups._children" Sequence="10">
      <CommandUIDefinition><Group Id="Group.Form" Title="Form" Template="Mscrm.Templates.Flexible2" Sequence="10"><Controls /></Group></CommandUIDefinition>
    </CustomAction>
    <CustomAction Id="Original.A.Action" Location="Group.Home.Controls._children" Sequence="10" VendorAction="keep">
      <CommandUIDefinition><Button Id="Button.A" Command="cmd.A" LabelText="A" TemplateAlias="o1" Sequence="10" VendorButton="keep" /></CommandUIDefinition>
    </CustomAction>
    <CustomAction Id="Original.Delete.Action" Location="Group.Home.Controls._children" Sequence="20">
      <CommandUIDefinition><Button Id="Button.Delete" Command="cmd.Delete" LabelText="Delete" TemplateAlias="o1" Sequence="20" /></CommandUIDefinition>
    </CustomAction>
  </CustomActions>
  <CommandDefinitions>
    <CommandDefinition Id="cmd.A"><EnableRules/><DisplayRules/><Actions><Url Address="/original" /></Actions></CommandDefinition>
    <CommandDefinition Id="cmd.Delete"><EnableRules/><DisplayRules/><Actions><Url Address="/delete" /></Actions></CommandDefinition>
  </CommandDefinitions>
  <RuleDefinitions><TabDisplayRules/><DisplayRules/><EnableRules/></RuleDefinitions>
  <LocLabels />
  <VendorSection Custom="keep"><Extension /></VendorSection>
</RibbonDiffXml>`;

const sourceApplication = `<RibbonDiffXml><CustomActions>
  <CustomAction Id="App.Old.Action" Location="Group.App.Controls._children" Sequence="10"><CommandUIDefinition><Button Id="App.A" Command="cmd.App" LabelText="Original app" TemplateAlias="o1" Sequence="10"/></CommandUIDefinition></CustomAction>
</CustomActions><CommandDefinitions><CommandDefinition Id="cmd.App"><EnableRules/><DisplayRules/><Actions><Url Address="/app"/></Actions></CommandDefinition></CommandDefinitions><RuleDefinitions/><LocLabels/></RibbonDiffXml>`;

function button(id: string, commandId: string, sequence: number): RibbonButton {
	return { id, commandId, label: id, sequence, kind: "button", templateAlias: "o1", hidden: false, oob: false, custom: true, managed: false };
}

function ribbon(location: RibbonLocation, tabs: RibbonDefinition["tabs"] = []): RibbonDefinition {
	return { location, entityLogicalName: location === "Application" ? "{!EntityLogicalName}" : "account", tabs };
}

function fixture() {
	const home = ribbon("HomepageGrid", [{
		id: "Tab.Home", label: "Home", sequence: 10, tabDisplayRules: [], groups: [
			{ id: "Group.Home", label: "Home", sequence: 10, template: "Flexible2", buttons: [button("Button.A", "cmd.A", 10), button("Button.Delete", "cmd.Delete", 20)] },
		]
	}]);
	const form = ribbon("Form", [{
		id: "Tab.Form", label: "Form", sequence: 10, tabDisplayRules: [], groups: [
			{ id: "Group.Form", label: "Form", sequence: 10, template: "Flexible2", buttons: [] },
		]
	}]);
	const app = ribbon("Application", [{
		id: "Tab.App", label: "App", sequence: 10, tabDisplayRules: [], groups: [
			{ id: "Group.App", label: "App", sequence: 10, template: "Flexible2", buttons: [button("App.A", "cmd.App", 10)] },
		]
	}]);
	const baseline: RibbonWorkspace = {
		ribbons: { HomepageGrid: home, SubGrid: ribbon("SubGrid"), Form: form, Application: app },
		commands: [
			{ id: "cmd.A", enableRules: [], displayRules: [], actions: [{ kind: "url", address: "/original", passParams: false, params: [] }] },
			{ id: "cmd.Delete", enableRules: [], displayRules: [], actions: [{ kind: "url", address: "/delete", passParams: false, params: [] }] },
			{ id: "cmd.App", enableRules: [], displayRules: [], actions: [{ kind: "url", address: "/app", passParams: false, params: [] }] },
		], enableRules: [], displayRules: [], locLabels: [],
	};
	const current = structuredClone(baseline);
	const sourceSnapshot: RibbonSourceSnapshot = {
		organizationUrl: "https://crm.example.test/Org", solutionUniqueName: "PreviewSolution", entityLogicalName: "account",
		solutionVersion: "1.0.0.0", solutionXml: "<ImportExportXml/>", customizationsXml: "<ImportExportXml/>",
		entityRibbonXml: sourceEntity, applicationRibbonXml: sourceApplication, capturedAt: "2026-10-15T00:00:00Z",
	};
	return { current, baseline, sourceSnapshot };
}

function parseXml(xml: string): Document {
	const parsed = new DOMParser().parseFromString(xml, "application/xml");
	expect(parsed.querySelector("parsererror")).toBeNull();
	return parsed;
}

describe("preservation-aware ribbon preview", () => {
	it("merges a Form B control into the complete entity source preserving Home A and unknown XML", () => {
		const input = fixture();
		input.current.ribbons.Form.tabs[0].groups[0].buttons.push(button("Button.B", "cmd.B", 20));
		input.current.commands.push({ id: "cmd.B", enableRules: [], displayRules: [], actions: [{ kind: "url", address: "/b", passParams: false, params: [] }] });
		const result = buildRibbonPreview(input, "entity");
		const xml = parseXml(result.mergedXml);
		expect(result.originalXml).toBe(sourceEntity);
		expect(result.changed).toBe(true);
		expect(result.deltas).toHaveLength(3);
		expect(xml.querySelector('Button[Id="Button.A"]')).not.toBeNull();
		expect(xml.querySelector('Button[Id="Button.B"]')).not.toBeNull();
		expect(xml.querySelector('CustomAction[Id="Original.A.Action"]')?.getAttribute("VendorAction")).toBe("keep");
		expect(xml.querySelector('Button[Id="Button.A"]')?.getAttribute("VendorButton")).toBe("keep");
		expect(xml.querySelector('VendorSection[Custom="keep"] Extension')).not.toBeNull();
		expect(xml.querySelector('CommandDefinition[Id="cmd.B"] > Actions > Url')?.getAttribute("Address")).toBe("/b");
		expect(result.mergedXml).not.toContain("App.Old.Action");
	});

	it("keeps the application ribbon in a separate complete source/target pair", () => {
		const input = fixture();
		input.current.ribbons.Application.tabs[0].groups[0].buttons.push(button("App.B", "cmd.App", 20));
		const app = buildRibbonPreview(input, "application");
		const entity = buildRibbonPreview(input, "entity");
		expect(app.originalXml).toBe(sourceApplication);
		expect(app.deltas).toHaveLength(1);
		expect(parseXml(app.mergedXml).querySelector('Button[Id="App.B"]')).not.toBeNull();
		expect(app.mergedXml).not.toContain("Original.A.Action");
		expect(entity.changed).toBe(false);
		expect(entity.mergedXml).not.toContain("App.B");
	});

	it("previews command-only edits even when control structure is unchanged", () => {
		const input = fixture();
		input.current.commands[0].actions = [{ kind: "url", address: "/edited", passParams: false, params: [] }];
		const result = buildRibbonPreview(input, "entity");
		const xml = parseXml(result.mergedXml);
		expect(result.changed).toBe(true);
		expect(xml.querySelector('CommandDefinition[Id="cmd.A"] Url')?.getAttribute("Address")).toBe("/edited");
		expect(xml.querySelector('CustomAction[Id="Original.A.Action"]')).not.toBeNull();
	});

	it("applies explicit removals and group metadata patches to original exported XML", () => {
		const input = fixture();
		input.current.ribbons.HomepageGrid.tabs[0].groups[0].buttons.pop();
		input.current.ribbons.HomepageGrid.tabs[0].groups[0].label = "Renamed group";
		const result = buildRibbonPreview(input, "entity");
		const xml = parseXml(result.mergedXml);
		expect(result.deltas[0].removedControlIds).toContain("Button.Delete");
		expect(result.deltas[0].elementPatches).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "Group", id: "Group.Home" }),
		]));
		expect(xml.querySelector('Button[Id="Button.Delete"]')).toBeNull();
		expect(xml.querySelector('CustomAction[Id="Original.Delete.Action"]')).toBeNull();
		expect(xml.querySelector('Group[Id="Group.Home"]')?.getAttribute("Title")).toBe("$LocLabels:Group.Home.Title");
		expect(xml.querySelector('LocLabel[Id="Group.Home.Title"] Title')?.getAttribute("description")).toBe("Renamed group");
		expect(xml.querySelector('Button[Id="Button.A"]')).not.toBeNull();
	});

	it("refuses to produce a guessed document without exported source for this entity or application", () => {
		const input = fixture();
		expect(() => buildRibbonPreview({ ...input, sourceSnapshot: null }, "entity")).toThrow(/source|export|unavailable/i);
		expect(() => buildRibbonPreview({ ...input, sourceSnapshot: { ...input.sourceSnapshot, entityLogicalName: "contact" } }, "entity")).toThrow(/entity|workspace|source/i);
		expect(buildRibbonPreview({ ...input, sourceSnapshot: { ...input.sourceSnapshot, applicationRibbonXml: null } }, "application").originalXml).toBe('<RibbonDiffXml/>');
	});

	it("returns the unchanged raw source when the workspace has no edits", () => {
		const result = buildRibbonPreview(fixture(), 'entity');
		expect(result.mergedXml).toBe(result.originalXml);
		expect(result.changed).toBe(false);
	});

	it("fails closed on malformed or conflicting original XML instead of showing a generated fragment", () => {
		const input = fixture();
		input.current.commands[0].actions = [{ kind: "url", address: "/edited", passParams: false, params: [] }];
		expect(() => buildRibbonPreview({ ...input, sourceSnapshot: { ...input.sourceSnapshot, entityRibbonXml: "<RibbonDiffXml>" } }, "entity")).toThrow(/xml|parse/i);
		expect(() => buildRibbonPreview({ ...input, sourceSnapshot: { ...input.sourceSnapshot, entityRibbonXml: sourceEntity.replace("<CommandDefinitions>", '<CommandDefinitions><CommandDefinition Id="cmd.A"/>') } }, "entity")).toThrow(/duplicate|ambiguous/i);
	});
});
