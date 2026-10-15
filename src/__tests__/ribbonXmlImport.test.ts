import { describe, expect, it } from "vitest";
import type { RibbonWorkspace } from "@/types/workspace";
import { applyImportedRibbonXml } from "@/services/ribbonXmlImport";

function base(): RibbonWorkspace {
	const button = (id: string) => ({
		id, label: id, commandId: "Old.Command", templateAlias: "o1", sequence: 10,
		kind: "button" as const, hidden: false, oob: false, custom: true, managed: false
	});
	const group = (id: string, buttons: ReturnType<typeof button>[]) => ({ id, label: id, sequence: 10, template: "Mscrm.Templates.Flexible2", buttons });
	return {
		ribbons: {
			HomepageGrid: { location: "HomepageGrid", entityLogicalName: "account", tabs: [{ id: "Tab.Home", label: "Home", sequence: 10, groups: [group("Group.Home", [button("Existing")]), group("Group.Destination", [])], tabDisplayRules: [] }] },
			SubGrid: { location: "SubGrid", entityLogicalName: "account", tabs: [] },
			Form: { location: "Form", entityLogicalName: "account", tabs: [{ id: "Tab.Form", label: "Form", sequence: 10, groups: [group("Group.Form", [])], tabDisplayRules: [] }] },
			Application: { location: "Application", entityLogicalName: "{!EntityLogicalName}", tabs: [] },
		},
		commands: [{ id: "Old.Command", enableRules: [], displayRules: [], actions: [{ kind: "url", address: "/old", passParams: false, params: [] }] }],
		enableRules: [], displayRules: [], locLabels: [],
	};
}

const newButton = `<RibbonDiffXml><CustomActions><CustomAction Id="arbitrary.Move.CustomAction" Location="Group.Home.Controls._children" Sequence="40"><CommandUIDefinition>
  <Button Id="Added" LabelText="$LocLabels:Added.Label" Command="Imported.Command" Sequence="40" TemplateAlias="o1"/>
</CommandUIDefinition></CustomAction></CustomActions>
<CommandDefinitions><CommandDefinition Id="Imported.Command"><EnableRules><EnableRule Id="Imported.Enabled"/></EnableRules><DisplayRules><DisplayRule Id="Imported.Visible"/></DisplayRules><Actions>
  <JavaScriptFunction Library="$webresource:contoso_/js/action.js" FunctionName="go"><CrmParameter Value="PrimaryControl"/></JavaScriptFunction>
  <Url Address="/confirm" PassParams="1"><StringParameter Name="target" Value="next"/></Url>
</Actions></CommandDefinition></CommandDefinitions>
<RuleDefinitions><EnableRules><EnableRule Id="Imported.Enabled"><SelectionCountRule Minimum="1" Maximum="2"/></EnableRule></EnableRules>
<DisplayRules><DisplayRule Id="Imported.Visible"><EntityRule EntityName="account"/></DisplayRule></DisplayRules></RuleDefinitions>
<LocLabels><LocLabel Id="Added.Label"><Titles><Title languagecode="1033" description="Imported label"/><Title languagecode="1036" description="Étiquette"/></Titles></LocLabel></LocLabels>
</RibbonDiffXml>`;

describe("applyImportedRibbonXml", () => {
	it("imports real, ordered JavaScript and URL command actions, their parameters, rule steps, and localized labels", () => {
		const original = base();
		const next = applyImportedRibbonXml(original, base(), newButton, "HomepageGrid", "append");
		const command = next.commands.find(cmd => cmd.id === "Imported.Command")!;
		expect(command.actions.map(action => action.kind)).toEqual(["javascript", "url"]);
		expect(command.actions[0]).toMatchObject({ functionName: "go", library: "$webresource:contoso_/js/action.js", params: [{ kind: "CrmParameter", value: "PrimaryControl" }] });
		expect(command.actions[1]).toMatchObject({ address: "/confirm", passParams: true, params: [{ kind: "StringParameter", name: "target", value: "next" }] });
		expect(command.sourceXml).toContain("JavaScriptFunction");
		expect(next.enableRules.find(rule => rule.id === "Imported.Enabled")).toMatchObject({ steps: [{ kind: "SelectionCountRule", minimum: 1, maximum: 2 }] });
		expect(next.displayRules.find(rule => rule.id === "Imported.Visible")?.steps[0]).toMatchObject({ kind: "EntityRule", entityName: "account" });
		expect(next.locLabels.find(label => label.id === "Added.Label")?.titles).toEqual([
			{ languageCode: 1033, description: "Imported label" }, { languageCode: 1036, description: "Étiquette" },
		]);
		const button = next.ribbons.HomepageGrid.tabs[0].groups[0].buttons.find(button => button.id === "Added");
		expect(button).toMatchObject({ label: "Imported label", commandId: "Imported.Command", sequence: 40 });
		expect(button?.sourceXml).toContain("$LocLabels:Added.Label");
		expect(next).not.toBe(original);
		expect(original.commands).toHaveLength(1);
	});

	it("append preserves edited buttons, other ribbon scopes, and unrelated current definitions", () => {
		const original = base();
		original.ribbons.HomepageGrid.tabs[0].groups[0].buttons[0].label = "Unpublished editor change";
		original.ribbons.Form.tabs[0].groups[0].buttons.push({ id: "Form.Unsaved", label: "Other scope edit", commandId: "Old.Command", templateAlias: "o1", sequence: 60, kind: "button", hidden: false, custom: true, managed: false, oob: false });
		original.commands[0].actions = [{ kind: "url", address: "/unsaved", passParams: false, params: [] }];
		const next = applyImportedRibbonXml(original, base(), newButton, "HomepageGrid", "append");
		expect(next.ribbons.HomepageGrid.tabs[0].groups[0].buttons.find(b => b.id === "Existing")?.label).toBe("Unpublished editor change");
		expect(next.ribbons.Form.tabs[0].groups[0].buttons[0].id).toBe("Form.Unsaved");
		expect(next.commands.find(c => c.id === "Old.Command")?.actions[0]).toMatchObject({ address: "/unsaved" });
	});

	it("replace restores the complete loaded workspace baseline before importing", () => {
		const original = base();
		original.commands[0].actions = [];
		original.ribbons.Form.tabs = [];
		original.locLabels.push({ id: "Unsaved.Label", titles: [{ languageCode: 1033, description: "Unpublished" }] });
		const baseline = base();
		const next = applyImportedRibbonXml(original, baseline, newButton, "HomepageGrid", "replace");
		expect(next.commands.find(c => c.id === "Old.Command")?.actions).toMatchObject([{ address: "/old" }]);
		expect(next.ribbons.Form.tabs).toEqual(baseline.ribbons.Form.tabs);
		expect(next.locLabels.some(l => l.id === "Unsaved.Label")).toBe(false);
		expect(next.ribbons.HomepageGrid.tabs[0].groups[0].buttons.some(b => b.id === "Added")).toBe(true);
		expect(original.ribbons.Form.tabs).toHaveLength(0);
	});

	it("overrides one button by existing control Location without duplicating its action or dropping sibling buttons", () => {
		const input = '<RibbonDiffXml><CustomActions><CustomAction Id="Any.override" Location="Existing" Sequence="45"><CommandUIDefinition><Button Id="Existing" LabelText="Changed" Command="Old.Command" TemplateAlias="o1" Sequence="45"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>';
		const next = applyImportedRibbonXml(base(), base(), input, "HomepageGrid", "append");
		const buttons = next.ribbons.HomepageGrid.tabs[0].groups[0].buttons;
		expect(buttons).toHaveLength(1);
		expect(buttons[0]).toMatchObject({ id: "Existing", label: "Changed", sequence: 45 });
	});

	it("preserves an existing icon, tooltips and custom source XML when an override only changes the label", () => {
		const original = base();
		const control = original.ribbons.HomepageGrid.tabs[0].groups[0].buttons[0];
		control.icon = "$webresource:original.svg";
		control.image16 = "$webresource:small.png";
		control.image32 = "$webresource:large.png";
		control.tooltipTitle = "Original tip";
		control.tooltipBody = "Original description";
		control.sourceXml = '<Button Id="Existing" LabelText="Before" ModernImage="$webresource:original.svg" Image16by16="$webresource:small.png" Image32by32="$webresource:large.png" ToolTipTitle="Original tip" ToolTipDescription="Original description" VendorOriginal="keep"/>';
		const xml = '<RibbonDiffXml><CustomActions><CustomAction Id="Override.Action" Location="Existing"><CommandUIDefinition><Button Id="Existing" LabelText="Renamed"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>';
		const changed = applyImportedRibbonXml(original, base(), xml, "HomepageGrid", "append");
		const button = changed.ribbons.HomepageGrid.tabs[0].groups[0].buttons[0];
		expect(button).toMatchObject({
			label: "Renamed", icon: "$webresource:original.svg", image16: "$webresource:small.png",
			image32: "$webresource:large.png", tooltipTitle: "Original tip", tooltipBody: "Original description",
			commandId: "Old.Command",
		});
		expect(button.sourceXml).toContain('VendorOriginal="keep"');
		expect(() => applyImportedRibbonXml(original, base(), xml.replace('LabelText="Renamed"', 'LabelText="Renamed" VendorNew="lost"'), "HomepageGrid", "append")).toThrow(/VendorNew|unsupported|extension/i);
	});

	it("imports a new tab and group from supported CustomActions without guessing placement", () => {
		const xml = '<RibbonDiffXml><CustomActions><CustomAction Id="Arbitrary.TabAction" Location="Mscrm.Tabs._children" Sequence="40"><CommandUIDefinition><Tab Id="Tab.Custom" Title="Custom Tab" Sequence="40"><Groups Id="Tab.Custom.Groups"><Group Id="Group.Custom" Title="Custom group" Sequence="10"><Controls Id="Group.Custom.Controls"/></Group></Groups></Tab></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>';
		const next = applyImportedRibbonXml(base(), base(), xml, "HomepageGrid", "append");
		const tab = next.ribbons.HomepageGrid.tabs.find(tab => tab.id === "Tab.Custom");
		expect(tab?.label).toBe("Custom Tab");
		expect(tab?.groups[0]).toMatchObject({ id: "Group.Custom", label: "Custom group" });
		expect(tab?.sourceXml).toContain('Groups Id="Tab.Custom.Groups"');
	});

	it("rejects new Tab/Group authoring fields that the existing generator would silently discard", () => {
		const attempts = [
			'<RibbonDiffXml><CustomActions><CustomAction Id="New.TabAction" Location="Mscrm.Tabs._children"><CommandUIDefinition><Tab Id="Tab.New" Title="A" Template="Vendor.TabTemplate"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>',
			'<RibbonDiffXml><CustomActions><CustomAction Id="New.GroupAction" Location="Tab.Home.Groups._children"><CommandUIDefinition><Group Id="Group.New" Title="A" Command="Some.Command"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>',
			'<RibbonDiffXml><CustomActions><CustomAction Id="New.GroupAction" Location="Tab.Home.Groups._children"><CommandUIDefinition><Group Id="Group.New" Title="A"><Controls Id="Different.Id"/></Group></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>',
			'<RibbonDiffXml><CustomActions><CustomAction Id="New.TabAction" Location="Mscrm.Tabs._children"><CommandUIDefinition><Tab Id="Tab.New" Title="A"><Groups Id="Wrong.Groups"/></Tab></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>',
		];
		for (const xml of attempts) {
			expect(() => applyImportedRibbonXml(base(), base(), xml, "HomepageGrid", "append")).toThrow(/unsupported|unrepresentable|lost|cannot preserve/i);
		}
	});

	it("imports a TabDisplayRule with supported steps without losing its source", () => {
		const original = base();
		original.ribbons.HomepageGrid.tabs[0].commandId = "Tab.Home.Command";
		const xml = '<RibbonDiffXml><RuleDefinitions><TabDisplayRules><TabDisplayRule TabCommand="Tab.Home.Command"><DisplayRules><EntityRule EntityName="account" Context="HomePageGrid"/><PageRule Address="/home"/></DisplayRules></TabDisplayRule></TabDisplayRules></RuleDefinitions></RibbonDiffXml>';
		const next = applyImportedRibbonXml(original, base(), xml, "HomepageGrid", "append");
		const rules = next.ribbons.HomepageGrid.tabs[0].tabDisplayRules;
		expect(rules).toHaveLength(1);
		expect(rules[0].rules.map(rule => rule.kind)).toEqual(["EntityRule", "PageRule"]);
		expect(rules[0].sourceXml).toContain("TabDisplayRule");
	});

	it("retains mixed EntityRule and PageRule order in an imported TabDisplayRule", () => {
		const original = base();
		original.ribbons.HomepageGrid.tabs[0].commandId = "Tab.Home.Command";
		const xml = '<RibbonDiffXml><RuleDefinitions><TabDisplayRules><TabDisplayRule TabCommand="Tab.Home.Command"><DisplayRules><PageRule Address="/first"/><EntityRule EntityName="account"/><PageRule Address="/last"/></DisplayRules></TabDisplayRule></TabDisplayRules></RuleDefinitions></RibbonDiffXml>';
		const next = applyImportedRibbonXml(original, base(), xml, "HomepageGrid", "append");
		expect(next.ribbons.HomepageGrid.tabs[0].tabDisplayRules[0].rules.map(rule => rule.kind)).toEqual(["PageRule", "EntityRule", "PageRule"]);
	});

	it("moves a known button between exact group anchors even with an unconventional Move action ID", () => {
		const input = '<RibbonDiffXml><CustomActions><CustomAction Id="random.Move.CustomAction" Location="Group.Destination.Controls._children" Sequence="75"><CommandUIDefinition><Button Id="Existing" LabelText="Moved" Command="Old.Command" TemplateAlias="o1" Sequence="75"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>';
		const next = applyImportedRibbonXml(base(), base(), input, "HomepageGrid", "append");
		expect(next.ribbons.HomepageGrid.tabs[0].groups[0].buttons.some(b => b.id === "Existing")).toBe(false);
		expect(next.ribbons.HomepageGrid.tabs[0].groups[1].buttons[0]).toMatchObject({ id: "Existing", label: "Moved", sequence: 75 });
	});

	it("hides an existing button only if its exact Location resolves uniquely", () => {
		const next = applyImportedRibbonXml(base(), base(), '<RibbonDiffXml><CustomActions><HideCustomAction HideActionId="CustomId" Location="Existing"/></CustomActions></RibbonDiffXml>', "HomepageGrid", "append");
		expect(next.ribbons.HomepageGrid.tabs[0].groups[0].buttons[0].hidden).toBe(true);
		expect(() => applyImportedRibbonXml(base(), base(), '<RibbonDiffXml><CustomActions><HideCustomAction HideActionId="X" Location="Unknown"/></CustomActions></RibbonDiffXml>', "HomepageGrid", "append")).toThrow(/location|unknown|target/i);
	});

	it("retains nested flyout XML under an imported control while exposing its top-level canvas item", () => {
		const input = '<RibbonDiffXml><CustomActions><CustomAction Id="Flyout.Action" Location="Group.Home.Controls._children"><CommandUIDefinition><FlyoutAnchor Id="Flyout" Command="Old.Command" LabelText="Flyout" Sequence="30"><Menu Id="Menu"><MenuSection Id="Section"><Controls><Button Id="Nested" LabelText="Nested"/></Controls></MenuSection></Menu></FlyoutAnchor></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>';
		const next = applyImportedRibbonXml(base(), base(), input, "HomepageGrid", "append");
		const buttons = next.ribbons.HomepageGrid.tabs[0].groups[0].buttons;
		expect(buttons.some(b => b.id === "Flyout" && b.kind === "flyout")).toBe(true);
		expect(buttons.find(b => b.id === "Flyout")?.sourceXml).toContain('<Menu Id="Menu">');
	});

	it("rejects unsupported actions, unparsed rule steps, and nonempty custom templates without altering input", () => {
		const original = base();
		const before = structuredClone(original);
		for (const bad of [
			'<RibbonDiffXml><CommandDefinitions><CommandDefinition Id="Bad"><Actions><PowerFxAction Formula="true"/></Actions></CommandDefinition></CommandDefinitions></RibbonDiffXml>',
			'<RibbonDiffXml><RuleDefinitions><EnableRules><EnableRule Id="Bad"><UnknownRule Enabled="1"/></EnableRule></EnableRules></RuleDefinitions></RibbonDiffXml>',
			'<RibbonDiffXml><Templates><RibbonTemplates Id="Mscrm.Templates"><Template Alias="unsafe"/></RibbonTemplates></Templates></RibbonDiffXml>',
			'<RibbonDiffXml><VendorExtension Flag="yes"/></RibbonDiffXml>',
			'<RibbonDiffXml><CommandDefinitions><CommandDefinition Id="Incomplete"><Actions><Url/></Actions></CommandDefinition></CommandDefinitions></RibbonDiffXml>',
			'<RibbonDiffXml><CustomActions><CustomAction Id="Bad" Location="Group.Home.Controls._children"><CommandUIDefinition><Button Id="Bad" Sequence="not-a-number"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>',
			'<RibbonDiffXml><CustomActions><CustomAction Id="Nested" Location="Group.Home.Controls._children"><CommandUIDefinition><FlyoutAnchor Id="Nested"><Menu><CommandDefinition Id="Injected"><Actions/></CommandDefinition></Menu></FlyoutAnchor></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>',
		]) {
			expect(() => applyImportedRibbonXml(original, base(), bad, "HomepageGrid", "append")).toThrow();
			expect(original).toEqual(before);
		}
	});

	it("refuses ambiguous actions, duplicate command IDs, invalid references, and wrong-scope location", () => {
		for (const bad of [
			'<RibbonDiffXml><CustomActions><CustomAction Id="Oops" Location="Unknown.Controls._children"><CommandUIDefinition><Button Id="New"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>',
			'<RibbonDiffXml><CustomActions><CustomAction Id="Oops" Location="Group.Form.Controls._children"><CommandUIDefinition><Button Id="New"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>',
			'<RibbonDiffXml><CustomActions><CustomAction Id="Oops" Location="Group.Home.Controls._children"><CommandUIDefinition><Button Id="New" Command="No.Such.Command"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>',
			'<RibbonDiffXml><CommandDefinitions><CommandDefinition Id="Duplicated"/><CommandDefinition Id="Duplicated"/></CommandDefinitions></RibbonDiffXml>',
			'<RibbonDiffXml><CustomActions><CustomAction Id="Two" Location="Group.Home.Controls._children"><CommandUIDefinition><Button Id="A"/><Button Id="B"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>',
			'<RibbonDiffXml><CustomActions><CustomAction Id="Undefined" Location="Group.Home.Controls._children"><CommandUIDefinition><Button Id="A" LabelText="$LocLabels:Missing"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>',
		]) expect(() => applyImportedRibbonXml(base(), base(), bad, "HomepageGrid", "append")).toThrow();
	});

	it("rejects mismatched active workspace identities, malformed XML, and DTD before modifying state", () => {
		const different = base();
		different.ribbons.HomepageGrid.entityLogicalName = "contact";
		expect(() => applyImportedRibbonXml(different, base(), newButton, "HomepageGrid", "append")).toThrow(/entity|workspace|identity/i);
		expect(() => applyImportedRibbonXml(base(), base(), '<RibbonDiffXml>', "HomepageGrid", "append")).toThrow(/xml|parse/i);
		expect(() => applyImportedRibbonXml(base(), base(), '<!DOCTYPE RibbonDiffXml><RibbonDiffXml/>', "HomepageGrid", "append")).toThrow(/doctype/i);
	});
});
