import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRibbonXml } from "@/services/xmlParser";
import { generateRibbonDelta, generateRibbonDiffXml, summarizeRibbonDiff, wrapInCustomizationsXml } from "@/services/xmlGenerator";
import type { RibbonButton, RibbonDefinition } from "@/types/ribbon";
import type { RibbonDefinitions } from "@/types/workspace";

const accountXml = readFileSync(resolve(__dirname, "../__fixtures__/ribbon/account-full.xml"), "utf8");

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function setup() {
	const parsed = parseRibbonXml(accountXml, "HomepageGrid", "account");
	const definitions: RibbonDefinitions = {
		commands: clone(parsed.commands),
		enableRules: clone(parsed.enableRules),
		displayRules: clone(parsed.displayRules),
		locLabels: clone(parsed.locLabels),
	};
	const baselineDefinitions = clone(definitions);
	const current = clone(parsed.ribbon);
	const baseline = clone(parsed.ribbon);
	const input = () => ({
		current,
		baseline,
		...definitions,
		baselineDefinitions,
		location: current.location,
		entityLogicalName: current.entityLogicalName,
	});
	return { current, baseline, definitions, baselineDefinitions, input };
}

function findControl(ribbon: RibbonDefinition, id: string): RibbonButton {
	const match = ribbon.tabs.flatMap(t => t.groups.flatMap(g => g.buttons)).find(b => b.id === id);
	if (!match) throw new Error(`Missing fixture control ${id}`);
	return match;
}

function tagElements(xml: string, selector: string): Element[] {
	const doc = new DOMParser().parseFromString(xml, "application/xml");
	expect(doc.querySelector("parsererror")).toBeNull();
	return [...doc.querySelectorAll(selector)];
}

describe("serializer regression contract", () => {
	it("emits an existing command edited without touching its button", () => {
		const { current, baseline, definitions, baselineDefinitions, input } = setup();
		const cmd = definitions.commands.find(c => c.id === "Contoso.account.CreditCheck.Command")!;
		cmd.actions = [{ kind: "javascript", library: "$webresource:contoso_/scripts/updated.js", functionName: "Contoso.Updated.run", params: [] }];
		expect(summarizeRibbonDiff(current, baseline, definitions, baselineDefinitions).hasAnyChange).toBe(true);
		const xml = generateRibbonDelta(input()).xml;
		expect(xml).toContain("Contoso.Updated.run");
		expect(tagElements(xml, "CommandDefinitions > CommandDefinition").map(e => e.getAttribute("Id"))).toContain(cmd.id);
		expect(tagElements(xml, "CustomAction")).toHaveLength(0);
	});

	it("emits edited enable-rule definition independently of button and command modifications", () => {
		const { current, baseline, definitions, baselineDefinitions, input } = setup();
		const rule = definitions.enableRules.find(r => r.id === "Contoso.account.CreditCheck.EnableRule" && r.steps.length > 0)!;
		rule.steps = [{ kind: "SelectionCountRule", minimum: 2 }];
		expect(summarizeRibbonDiff(current, baseline, definitions, baselineDefinitions).hasAnyChange).toBe(true);
		const xml = generateRibbonDelta(input()).xml;
		expect(tagElements(xml, 'RuleDefinitions > EnableRules > EnableRule[Id="Contoso.account.CreditCheck.EnableRule"]')).toHaveLength(1);
		expect(xml).toContain('Minimum="2"');
	});

	it("reorder of two existing buttons produces stable sequence overrides in their displayed order", () => {
		const { current, baseline, input } = setup();
		const group = current.tabs[0].groups[0];
		const moved = group.buttons.shift()!;
		group.buttons.push(moved);
		expect(summarizeRibbonDiff(current, baseline).hasAnyChange).toBe(true);
		const delta = generateRibbonDelta(input());
		const entries = tagElements(delta.xml, 'CustomActions > CustomAction');
		expect(entries.length).toBeGreaterThan(1);
		const emitted = entries.map(e => ({ id: e.querySelector("CommandUIDefinition > Button")?.getAttribute("Id"), sequence: Number(e.getAttribute("Sequence")) }));
		const ordered = emitted.filter(e => group.buttons.some(b => b.id === e.id)).sort((a, b) => a.sequence - b.sequence);
		expect(ordered.map(e => e.id)).toEqual(group.buttons.map(b => b.id));
		const secondRun = generateRibbonDelta(input());
		expect(secondRun).toEqual(delta);
	});

	it("normalizes collision-prone sequence values when a new control is inserted", () => {
		const { current, input } = setup();
		const group = current.tabs[0].groups[0];
		const example = clone(group.buttons[0]);
		group.buttons.splice(1, 0, { ...example, id: "Contoso.account.NewControl", commandId: "", label: "Inserted", sequence: group.buttons[0].sequence, sourceXml: undefined });
		const xml = generateRibbonDelta(input()).xml;
		const actions = tagElements(xml, 'CustomActions > CustomAction');
		const order = actions.map(e => ({
			id: e.querySelector(':scope > CommandUIDefinition > Button')?.getAttribute("Id"),
			sequence: Number(e.getAttribute("Sequence")),
		})).filter(e => group.buttons.some(b => b.id === e.id));
		expect(order).toHaveLength(group.buttons.length);
		const ordered = [...order].sort((a, b) => a.sequence - b.sequence);
		expect(new Set(order.map(e => e.sequence)).size).toBe(group.buttons.length);
		expect(ordered.map(e => e.id)).toEqual(group.buttons.map(b => b.id));
	});

	it("OOB label-only edit preserves its existing system command rather than redefining it", () => {
		const { current, input } = setup();
		findControl(current, "Mscrm.HomepageGrid.account.MainTab.New.Controls.NewRecord").label = "New account";
		const xml = generateRibbonDelta(input()).xml;
		expect(xml).toContain("New account");
		expect(tagElements(xml, 'CommandDefinitions > CommandDefinition[Id="Mscrm.NewRecordFromGrid"]')).toHaveLength(0);
	});

	it("emits an intentional system command override when an explicit baseline proves the command changed", () => {
		const { definitions, baselineDefinitions, input } = setup();
		const command = definitions.commands.find(c => c.id === "Mscrm.NewRecordFromGrid")!;
		command.actions = [{ kind: "javascript", library: "$webresource:contoso_/record.js", functionName: "Contoso.OpenRecord", params: [] }];
		const xml = generateRibbonDelta(input()).xml;
		expect(tagElements(xml, 'CommandDefinitions > CommandDefinition[Id="Mscrm.NewRecordFromGrid"]')).toHaveLength(1);
		expect(xml).toContain("Contoso.OpenRecord");
		expect(baselineDefinitions.commands.find(c => c.id === command.id)?.actions).not.toEqual(command.actions);
	});

	it("rejects a system command definition authored without any baseline proof", () => {
		const { input } = setup();
		const unsafe = input();
		unsafe.baselineDefinitions = undefined as unknown as RibbonDefinitions;
		unsafe.commands = [
			...unsafe.commands.filter(c => c.id !== "Mscrm.NewRecordFromGrid"),
			{ id: "Mscrm.NewRecordFromGrid", enableRules: [], displayRules: [], actions: [{ kind: "url", address: "https://example.org", passParams: false, params: [] }] },
		];
		findControl(unsafe.current, "Mscrm.HomepageGrid.account.MainTab.New.Controls.NewRecord").label = "Override";
		expect(() => generateRibbonDelta(unsafe)).toThrow(/system command|baseline/i);
	});

	it("parses only real rule definitions, keeps ordered mixed actions and raw image values", () => {
		const xml = `<RibbonDefinitions><Ribbon><Tabs><Tab Id="T" Title="T"><Groups><Group Id="G" Label="G"><Controls><Button Id="B" LabelText="B" Command="C" ModernImage="$webresource:ab_/IconNew.svg" Image16by16="$webresource:ab_/old.png"/></Controls></Group></Groups></Tab></Tabs></Ribbon><CommandDefinitions><CommandDefinition Id="C"><EnableRules><EnableRule Id="R"/></EnableRules><DisplayRules/><Actions><JavaScriptFunction Library="$webresource:ab_/a.js" FunctionName="first"/><Url Address="https://example.org/second"/><JavaScriptFunction Library="$webresource:ab_/b.js" FunctionName="third"/></Actions></CommandDefinition></CommandDefinitions><RuleDefinitions><EnableRules><EnableRule Id="R"><SelectionCountRule Minimum="2"/></EnableRule></EnableRules></RuleDefinitions></RibbonDefinitions>`;
		const parsed = parseRibbonXml(xml, "HomepageGrid", "account");
		expect(parsed.enableRules).toHaveLength(1);
		expect(parsed.enableRules[0].steps).toHaveLength(1);
		expect(parsed.commands[0].actions.map(a => a.kind === "javascript" ? a.functionName : a.kind)).toEqual(["first", "url", "third"]);
		const button = findControl(parsed.ribbon, "B");
		expect(button.icon).toBe("$webresource:ab_/IconNew.svg");
		expect(button.image16).toBe("$webresource:ab_/old.png");
		expect(button.sourceXml).toContain("ModernImage");
		expect(parsed.commands[0].sourceXml).toContain("JavaScriptFunction");
		expect(parsed.enableRules[0].sourceXml).toContain("SelectionCountRule");
	});

	it("preserves unknown button attributes and nested flyout children on unrelated edit", () => {
		const xml = `<RibbonDefinitions><Ribbon><Tabs><Tab Id="T" Title="T"><Groups><Group Id="G" Label="G"><Controls><FlyoutAnchor Id="F" LabelText="Prior" TemplateAlias="o1" Command="C" Sequence="10" VendorFlag="Keep"><Menu><MenuSection Id="NestedSection"><Controls><Button Id="Nested" LabelText="Child"/></Controls></MenuSection></Menu></FlyoutAnchor></Controls></Group></Groups></Tab></Tabs></Ribbon></RibbonDefinitions>`;
		const parsed = parseRibbonXml(xml, "HomepageGrid", "account");
		const current = clone(parsed.ribbon);
		const baseline = clone(parsed.ribbon);
		const parent = findControl(current, "F");
		parent.label = "Renamed";
		const diff = generateRibbonDiffXml({ current, baseline, commands: [], enableRules: [], displayRules: [], locLabels: [], entityLogicalName: "account", location: "HomepageGrid" });
		const control = tagElements(diff, "CustomAction > CommandUIDefinition > FlyoutAnchor")[0];
		expect(control.getAttribute("VendorFlag")).toBe("Keep");
		expect(control.getAttribute("LabelText")).toContain("$LocLabels:");
		expect(control.querySelector('MenuSection[Id="NestedSection"] Button[Id="Nested"]')).not.toBeNull();
	});

	it("rejects an unsupported edited command action instead of dropping it", () => {
		const { definitions, input } = setup();
		const cmd = definitions.commands.find(c => c.id === "Contoso.account.CreditCheck.Command")!;
		cmd.actions.push({ kind: "powerFx", expression: "1+1" });
		expect(() => generateRibbonDelta(input())).toThrow(/unsupported|powerFx/i);
	});

	it("retains an unsupported existing command action when only its rule references change", () => {
		const { definitions, baselineDefinitions, input } = setup();
		const cmd = definitions.commands.find(c => c.id === "Contoso.account.CreditCheck.Command")!;
		const raw = cmd.sourceXml!;
		cmd.sourceXml = raw.replace("</Actions>", '<VendorCall Id="keep-me"/></Actions>');
		baselineDefinitions.commands.find(c => c.id === cmd.id)!.sourceXml = cmd.sourceXml;
		cmd.enableRules = [];
		const xml = generateRibbonDelta(input()).xml;
		const edited = tagElements(xml, `CommandDefinitions > CommandDefinition[Id="${cmd.id}"]`)[0];
		expect(edited.querySelector('Actions > VendorCall[Id="keep-me"]')).not.toBeNull();
	});

	it("throws for an edited command's unmodelled action instead of truncating it", () => {
		const { definitions, baselineDefinitions, input } = setup();
		const cmd = definitions.commands.find(c => c.id === "Contoso.account.CreditCheck.Command")!;
		cmd.sourceXml = cmd.sourceXml!.replace("</Actions>", '<VendorCall Id="must-survive"/></Actions>');
		baselineDefinitions.commands.find(c => c.id === cmd.id)!.sourceXml = cmd.sourceXml;
		cmd.actions.push({ kind: "url", address: "https://new.example.net", passParams: false, params: [] });
		expect(() => generateRibbonDelta(input())).toThrow(/unsafe partial rewrite|unrecognized action/i);
	});

	it("rejects an action rewrite when a parameter has an unknown vendor attribute", () => {
		const { definitions, baselineDefinitions, input } = setup();
		const cmd = definitions.commands.find(c => c.id === "Contoso.account.CreditCheck.Command")!;
		const raw = cmd.sourceXml!.replace('<CrmParameter Value="PrimaryControl"', '<CrmParameter VendorArgument="persist" Value="PrimaryControl"');
		cmd.sourceXml = raw;
		baselineDefinitions.commands.find(c => c.id === cmd.id)!.sourceXml = raw;
		cmd.actions = [{ kind: "url", address: "https://example.org/new", passParams: false, params: [] }];
		expect(() => generateRibbonDelta(input())).toThrow(/unsafe partial rewrite|unknown/i);
	});

	it("throws if a loaded rule with unmodelled children is edited", () => {
		const { definitions, baselineDefinitions, input } = setup();
		const rule = definitions.enableRules.find(r => r.id === "Contoso.account.CreditCheck.EnableRule")!;
		rule.sourceXml = rule.sourceXml!.replace("</EnableRule>", '<VendorRule Id="preserve"/></EnableRule>');
		baselineDefinitions.enableRules.find(r => r.id === rule.id)!.sourceXml = rule.sourceXml;
		rule.steps = [{ kind: "SelectionCountRule", minimum: 9 }];
		expect(() => generateRibbonDelta(input())).toThrow(/unsafe partial rewrite|unknown rule/i);
	});

	it("rejects rewriting a rule if an unknown step attribute would be discarded", () => {
		const { definitions, baselineDefinitions, input } = setup();
		const rule = definitions.enableRules.find(r => r.id === "Contoso.account.CreditCheck.EnableRule")!;
		const alteredXml = rule.sourceXml!.replace('<SelectionCountRule Minimum="1"', '<SelectionCountRule VendorAttribute="preserve" Minimum="1"');
		rule.sourceXml = alteredXml;
		baselineDefinitions.enableRules.find(r => r.id === rule.id)!.sourceXml = alteredXml;
		rule.steps = [{ kind: "SelectionCountRule", minimum: 3, appliesTo: "SelectedEntity" }];
		expect(() => generateRibbonDelta(input())).toThrow(/unsafe partial rewrite|unknown|unmodelled/i);
	});

	it("rejects cloning a sourced flyout with nested child IDs into a new control ID", () => {
		const xml = `<RibbonDefinitions><Ribbon><Tabs><Tab Id="T" Title="T"><Groups><Group Id="G" Label="G"><Controls><FlyoutAnchor Id="F" LabelText="Parent" Sequence="10"><Menu><MenuSection Id="NestedSection"><Controls><Button Id="NestedButton" LabelText="Nested"/></Controls></MenuSection></Menu></FlyoutAnchor></Controls></Group></Groups></Tab></Tabs></Ribbon></RibbonDefinitions>`;
		const parsed = parseRibbonXml(xml, "HomepageGrid", "account");
		const current = clone(parsed.ribbon);
		const parent = findControl(current, "F");
		current.tabs[0].groups[0].buttons.push({ ...clone(parent), id: "F.Copy", sequence: 20 });
		expect(() => generateRibbonDelta({ current, baseline: parsed.ribbon, commands: [], enableRules: [], displayRules: [], locLabels: [], entityLogicalName: "account", location: "HomepageGrid" })).toThrow(/duplicate|nested|unsafe|unrepresentable/i);
	});

	it("emits narrow metadata patches for existing tabs and groups without copying merged subtrees", () => {
		const modifiedTab = setup();
		modifiedTab.current.tabs[0].label = "Existing tab renamed";
		modifiedTab.current.tabs[0].commandId = "Contoso.New.TabCommand";
		const tabDelta = generateRibbonDelta(modifiedTab.input());
		const tabPatch = tabDelta.elementPatches?.find(p => p.kind === "Tab" && p.id === modifiedTab.current.tabs[0].id);
		expect(tabPatch?.attributes).toMatchObject({ Title: `$LocLabels:${modifiedTab.current.tabs[0].id}.Title`, Command: "Contoso.New.TabCommand" });
		expect(tabDelta.xml).toContain('description="Existing tab renamed"');
		expect(tagElements(tabDelta.xml, "CustomActions > CustomAction")).toHaveLength(0);
		const modifiedGroup = setup();
		modifiedGroup.current.tabs[0].groups[0].label = "Existing group renamed";
		modifiedGroup.current.tabs[0].groups[0].template = "Mscrm.Templates.ThreeLarge";
		const groupDelta = generateRibbonDelta(modifiedGroup.input());
		const groupPatch = groupDelta.elementPatches?.find(p => p.kind === "Group" && p.id === modifiedGroup.current.tabs[0].groups[0].id);
		expect(groupPatch?.attributes).toMatchObject({ Title: `$LocLabels:${modifiedGroup.current.tabs[0].groups[0].id}.Title`, Template: "Mscrm.Templates.ThreeLarge" });
		expect(groupDelta.xml).toContain('description="Existing group renamed"');
		expect(tagElements(groupDelta.xml, "CustomActions > CustomAction")).toHaveLength(0);
	});

	it("detects existing tab/group order changes and publishes exact sequence patches", () => {
		const { current, baseline, input } = setup();
		const otherTab = clone(current.tabs[0]);
		otherTab.id = "Contoso.account.SecondTab";
		otherTab.sequence = 20;
		otherTab.groups = [];
		current.tabs.push(clone(otherTab));
		baseline.tabs.push(clone(otherTab));
		current.tabs.reverse();
		current.tabs[1].groups.reverse();
		const delta = generateRibbonDelta(input());
		const tabPatches = delta.elementPatches?.filter(p => p.kind === "Tab") ?? [];
		const groupPatches = delta.elementPatches?.filter(p => p.kind === "Group") ?? [];
		expect(tabPatches).toHaveLength(2);
		expect(tabPatches.map(p => p.attributes.Sequence)).toEqual(["10", "20"]);
		expect(groupPatches).toHaveLength(2);
		expect(groupPatches.map(p => p.attributes.Sequence)).toEqual(["10", "20"]);
		expect(summarizeRibbonDiff(current, baseline).hasAnyChange).toBe(true);
	});

	it("emits explicit unhide, control and definition removal intents", () => {
		const { current, definitions, input } = setup();
		const tab = current.tabs[0];
		const group = tab.groups.find(g => g.buttons.some(b => b.id.endsWith(".Email")))!;
		const existingHidden = group.buttons.find(b => b.hidden)!;
		expect(existingHidden).toBeDefined();
		existingHidden.hidden = false;
		const remove = current.tabs[0].groups[0].buttons.find(b => b.id === "Contoso.account.CreditCheck.Button")!;
		current.tabs[0].groups[0].buttons = current.tabs[0].groups[0].buttons.filter(b => b !== remove);
		definitions.commands = definitions.commands.filter(c => c.id !== "Contoso.account.CreditCheck.Command");
		const delta = generateRibbonDelta(input());
		expect(delta.unhiddenControlIds).toContain(existingHidden.id);
		expect(delta.removedControlIds).toContain(remove.id);
		expect(delta.removedCommandIds).toContain("Contoso.account.CreditCheck.Command");
	});

	it("cross-parent relocation is an explicit remove then reinsert at the new parent", () => {
		const { current, input } = setup();
		const src = current.tabs[0].groups[0];
		const dst = current.tabs[0].groups[1];
		const moved = src.buttons.find(b => b.id === "Contoso.account.CreditCheck.Button")!;
		src.buttons = src.buttons.filter(b => b.id !== moved.id);
		dst.buttons.push(moved);
		const delta = generateRibbonDelta(input());
		expect(delta.removedControlIds).toContain(moved.id);
		const action = tagElements(delta.xml, "CustomAction").find(e => e.querySelector(`[Id="${moved.id}"]`));
		expect(action?.getAttribute("Location")).toBe(`${dst.id}.Controls._children`);
		expect(action?.getAttribute("Id")).toBe(`${moved.id}.Move.CustomAction`);
	});

	it("reports changed and removed tab rules/scaling without re-emitting untouched tab rules", () => {
		const { current, baseline, input } = setup();
		const baselineTab = baseline.tabs[0];
		baselineTab.commandId = "TabCommand";
		current.tabs[0].commandId = "TabCommand";
		baselineTab.tabDisplayRules = [{ tabCommand: "TabCommand", rules: [{ kind: "EntityRule", entityName: "account" }] }];
		current.tabs[0].tabDisplayRules = [];
		baseline.scalingByTab = { [baselineTab.id]: { tabId: baselineTab.id, maxSizes: [], scales: [] } };
		const delta = generateRibbonDelta(input());
		expect(delta.removedTabDisplayRuleCommands).toContain("TabCommand");
		expect(delta.removedScalingTabIds).toContain(baselineTab.id);
		expect(tagElements(delta.xml, "TabDisplayRule")).toHaveLength(0);
	});

	it("retains unknown TabDisplayRule attributes when changing its supported rule steps", () => {
		const xml = readFileSync(resolve(__dirname, "../__fixtures__/ribbon/all-rule-kinds.xml"), "utf8");
		const parsed = parseRibbonXml(xml, "HomepageGrid", "account");
		const baseline = clone(parsed.ribbon);
		const current = clone(parsed.ribbon);
		const old = baseline.tabs[0].tabDisplayRules[0];
		const edited = current.tabs[0].tabDisplayRules[0];
		const raw = edited.sourceXml!.replace("<TabDisplayRule ", '<TabDisplayRule VendorRule="stay" ');
		old.sourceXml = raw;
		edited.sourceXml = raw;
		edited.rules[1] = { kind: "PageRule", address: "https://example.org/revised" };
		const delta = generateRibbonDelta({ current, baseline, commands: [], enableRules: [], displayRules: [], locLabels: [], entityLogicalName: "account", location: "HomepageGrid" });
		const rule = tagElements(delta.xml, 'TabDisplayRules > TabDisplayRule[TabCommand="TestTab.Command"]')[0];
		expect(rule.getAttribute("VendorRule")).toBe("stay");
		expect(rule.querySelector('PageRule')?.getAttribute("Address")).toBe("https://example.org/revised");
	});

	it("emits only changed localized labels without unnecessarily replacing controls", () => {
		const { definitions, baselineDefinitions, current, baseline, input } = setup();
		const label = definitions.locLabels.find(l => l.id === "Contoso.account.CreditCheck.Button.LabelText")!;
		label.titles.push({ languageCode: 1036, description: "Vérification" });
		expect(summarizeRibbonDiff(current, baseline, definitions, baselineDefinitions).hasAnyChange).toBe(true);
		const xml = generateRibbonDelta(input()).xml;
		expect(xml).toContain("Vérification");
		expect(tagElements(xml, "CustomAction")).toHaveLength(0);
		expect(tagElements(xml, 'LocLabels > LocLabel[Id="Contoso.account.CreditCheck.Button.LabelText"]')).toHaveLength(1);
	});

	it("retains unknown localization attributes while editing its text", () => {
		const { definitions, baselineDefinitions, input } = setup();
		const id = "Contoso.account.CreditCheck.Button.LabelText";
		const label = definitions.locLabels.find(l => l.id === id)!;
		const raw = label.sourceXml!.replace('<LocLabel Id=', '<LocLabel VendorLabelFlag="preserve" Id=')
			.replace('languagecode="1033"', 'LanguageExtension="still-here" languagecode="1033"');
		label.sourceXml = raw;
		baselineDefinitions.locLabels.find(l => l.id === id)!.sourceXml = raw;
		label.titles[0].description = "Edited translation";
		const xml = generateRibbonDelta(input()).xml;
		const loc = tagElements(xml, `LocLabels > LocLabel[Id="${id}"]`)[0];
		expect(loc.getAttribute("VendorLabelFlag")).toBe("preserve");
		const title = loc.querySelector('Titles > Title[languagecode="1033"]')!;
		expect(title.getAttribute("LanguageExtension")).toBe("still-here");
		expect(title.getAttribute("description")).toBe("Edited translation");
	});

	it("edits sourced scaling without deleting unknown Scaling or MaxSize attributes", () => {
		const { current, baseline, input } = setup();
		const tabId = current.tabs[0].id;
		const raw = `<Scaling TabId="${tabId}" VendorScaling="persist"><MaxSize Id="Original.Max" GroupId="G" Size="Large" Sequence="10" VendorSize="keep"/></Scaling>`;
		const old = { tabId, maxSizes: [{ id: "Original.Max", groupId: "G", size: "Large", sequence: 10 }], scales: [], sourceXml: raw };
		baseline.scalingByTab = { [tabId]: clone(old) };
		current.scalingByTab = { [tabId]: clone(old) };
		current.scalingByTab[tabId].maxSizes[0].size = "Small";
		const xml = generateRibbonDelta(input()).xml;
		const el = tagElements(xml, `Scalings > Scaling[TabId="${tabId}"]`)[0];
		expect(el.getAttribute("VendorScaling")).toBe("persist");
		expect(el.querySelector("MaxSize")?.getAttribute("VendorSize")).toBe("keep");
		expect(el.querySelector("MaxSize")?.getAttribute("Size")).toBe("Small");
	});

	it("wraps customizations under <Entity><Name> child and supports a separate form path", () => {
		const fragment = "<RibbonDiffXml/>";
		const entity = wrapInCustomizationsXml(fragment, "account", "entity");
		const entityNode = tagElements(entity, "Entities > Entity")[0];
		expect(entityNode.querySelector(":scope > Name")?.textContent).toBe("account");
		expect(entityNode.hasAttribute("Name")).toBe(false);
		expect(entityNode.querySelector(":scope > RibbonDiffXml")).not.toBeNull();
		const form = wrapInCustomizationsXml(fragment, "account", "form", "c60f2e24-52f1-4a60-b4d4-1161093ae9ae");
		expect(tagElements(form, "Entities > Entity > FormXml > forms > systemform > form > RibbonDiffXml")).toHaveLength(1);
	});
});
