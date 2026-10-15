import { describe, it, expect } from "vitest";
import { generateRibbonDiffXml, escapeXml, wrapInCustomizationsXml } from "@/services/xmlGenerator";
import { parseRibbonXml } from "@/services/xmlParser";
import type {
	RibbonDefinition,
	CommandDefinition,
	EnableRule,
	DisplayRule,
	LocLabel,
} from "@/types/ribbon";

// ── Helpers ────────────────────────────────────────────────────────────────

const emptyBaseline: RibbonDefinition = {
	location: "HomepageGrid",
	entityLogicalName: "account",
	tabs: [],
};

function makeInput(
	current: RibbonDefinition,
	baseline: RibbonDefinition = emptyBaseline,
	commands: CommandDefinition[] = [],
	enableRules: EnableRule[] = [],
	displayRules: DisplayRule[] = [],
	locLabels: LocLabel[] = [],
) {
	return {
		current,
		baseline,
		commands,
		enableRules,
		displayRules,
		locLabels,
		entityLogicalName: current.entityLogicalName || "account",
		location: current.location,
	};
}

// ── escapeXml ──────────────────────────────────────────────────────────────

describe("escapeXml", () => {
	it("escapes & as &amp;", () => {
		expect(escapeXml("a & b")).toBe("a &amp; b");
	});

	it("escapes < and > as &lt; and &gt;", () => {
		expect(escapeXml("<script>")).toBe("&lt;script&gt;");
	});

	it("escapes double quotes as &quot;", () => {
		expect(escapeXml('say "hello"')).toBe("say &quot;hello&quot;");
	});

	it("escapes single quotes as &apos;", () => {
		expect(escapeXml("it's")).toBe("it&apos;s");
	});

	it("leaves safe strings untouched", () => {
		expect(escapeXml("HelloWorld")).toBe("HelloWorld");
	});

	it("escapes & in URLs", () => {
		expect(escapeXml("https://example.com?a=1&b=2")).toBe("https://example.com?a=1&amp;b=2");
	});
});

// ── generateRibbonDiffXml — CustomAction generation ────────────────────────

describe("generateRibbonDiffXml — custom button", () => {
	it("generates CustomAction with correct Location for a new button in existing group", () => {
		const current: RibbonDefinition = {
			location: "HomepageGrid",
			entityLogicalName: "account",
			tabs: [
				{
					id: "Mscrm.HomepageGrid.account.MainTab",
					label: "Main Tab",
					sequence: 10,
					tabDisplayRules: [],
					groups: [
						{
							id: "Mscrm.HomepageGrid.account.MainTab.New",
							label: "New",
							sequence: 10,
							template: "Mscrm.Templates.Flexible2",
							buttons: [
								{
									id: "Contoso.account.CreditCheck.Button",
									label: "$LocLabels:Contoso.account.CreditCheck.LabelText",
									kind: "button",
									sequence: 50,
									templateAlias: "o1",
									commandId: "Contoso.account.CreditCheck.Command",
									hidden: false,
									oob: false,
									custom: true,
									managed: false,
								},
							],
						},
					],
				},
			],
		};

		const xml = generateRibbonDiffXml(makeInput(current));

		expect(xml).toContain('Location="Mscrm.HomepageGrid.account.MainTab.New.Controls._children"');
		expect(xml).toContain('Id="Contoso.account.CreditCheck.Button"');
	});

	it("generates CustomAction Location using {groupId}.Controls._children pattern", () => {
		const current: RibbonDefinition = {
			location: "HomepageGrid",
			entityLogicalName: "account",
			tabs: [
				{
					id: "Tab1",
					label: "Tab",
					sequence: 10,
					tabDisplayRules: [],
					groups: [
						{
							id: "Group1",
							label: "Group",
							sequence: 10,
							template: "Mscrm.Templates.Flexible2",
							buttons: [
								{
									id: "MyButton",
									label: "My Button",
									kind: "button",
									sequence: 10,
									templateAlias: "o1",
									commandId: "MyCommand",
									hidden: false,
									oob: false,
									custom: true,
									managed: false,
								},
							],
						},
					],
				},
			],
		};
		const xml = generateRibbonDiffXml(makeInput(current));
		expect(xml).toContain('Location="Group1.Controls._children"');
	});

	it("emits LocLabel entries for referenced labels", () => {
		const locLabels: LocLabel[] = [
			{
				id: "Contoso.account.Test.LabelText",
				titles: [{ languageCode: 1033, description: "Test Button" }],
			},
		];
		const current: RibbonDefinition = {
			location: "HomepageGrid",
			entityLogicalName: "account",
			tabs: [
				{
					id: "Tab1",
					label: "Tab",
					sequence: 10,
					tabDisplayRules: [],
					groups: [
						{
							id: "Group1",
							label: "Group",
							sequence: 10,
							template: "",
							buttons: [
								{
									id: "TestButton",
									label: "$LocLabels:Contoso.account.Test.LabelText",
									kind: "button",
									sequence: 10,
									templateAlias: "o1",
									commandId: "",
									hidden: false,
									oob: false,
									custom: true,
									managed: false,
								},
							],
						},
					],
				},
			],
		};
		const xml = generateRibbonDiffXml(makeInput(current, emptyBaseline, [], [], [], locLabels));
		expect(xml).toContain("Contoso.account.Test.LabelText");
		expect(xml).toContain("Test Button");
	});

	it("escapes & as &amp; in URL action href attributes", () => {
		expect(escapeXml("https://example.com?a=1&b=2&c=3")).toBe(
			"https://example.com?a=1&amp;b=2&amp;c=3",
		);
	});
});

// ── generateRibbonDiffXml — icon emission (web-resource only) ──────────────

describe("generateRibbonDiffXml — icon attributes", () => {
	function buttonWith(icon?: string, image16?: string, image32?: string): RibbonDefinition {
		return {
			location: "Form",
			entityLogicalName: "account",
			tabs: [
				{
					id: "T",
					label: "T",
					sequence: 10,
					tabDisplayRules: [],
					groups: [
						{
							id: "G",
							label: "G",
							sequence: 10,
							template: "",
							buttons: [
								{
									id: "b",
									label: "B",
									icon,
									image16,
									image32,
									kind: "button",
									sequence: 10,
									templateAlias: "o1",
									commandId: "",
									hidden: false,
									oob: false,
									custom: true,
									managed: false,
								},
							],
						},
					],
				},
			],
		};
	}

	it("does NOT emit a bare Fluent icon name as ModernImage", () => {
		const xml = generateRibbonDiffXml(makeInput(buttonWith("search")));
		expect(xml).not.toContain("ModernImage=");
		expect(xml).not.toContain("Image16by16=");
		expect(xml).not.toContain("Image32by32=");
	});

	it("emits ModernImage + Image attrs only for real $webresource refs", () => {
		const xml = generateRibbonDiffXml(
			makeInput(buttonWith("search", "$webresource:mxrm_/icons/search.svg", "$webresource:mxrm_/icons/search.svg")),
		);
		expect(xml).toContain('ModernImage="$webresource:mxrm_/icons/search.svg"');
		expect(xml).toContain('Image16by16="$webresource:mxrm_/icons/search.svg"');
		expect(xml).toContain('Image32by32="$webresource:mxrm_/icons/search.svg"');
	});
});

// ── generateRibbonDiffXml — HideCustomAction ───────────────────────────────

describe("generateRibbonDiffXml — HideCustomAction", () => {
	it("generates both the new control and HideCustomAction when a hidden button is absent from baseline", () => {
		const current: RibbonDefinition = {
			location: "HomepageGrid",
			entityLogicalName: "account",
			tabs: [
				{
					id: "Tab1",
					label: "Tab",
					sequence: 10,
					tabDisplayRules: [],
					groups: [
						{
							id: "Group1",
							label: "Group",
							sequence: 10,
							template: "",
							buttons: [
								{
									id: "Mscrm.HomepageGrid.account.MainTab.Actions.Controls.DeleteAccount",
									label: "Delete",
									kind: "button",
									sequence: 10,
									templateAlias: "o1",
									commandId: "Mscrm.DeleteRecord",
									hidden: true,
									oob: true,
									custom: false,
									managed: false,
								},
							],
						},
					],
				},
			],
		};
		const xml = generateRibbonDiffXml(makeInput(current));
		expect(xml).toContain("HideCustomAction");
		expect(xml).toContain(
			'Location="Mscrm.HomepageGrid.account.MainTab.Actions.Controls.DeleteAccount"',
		);
		// A newly authored control must first exist before a hide action can target it.
		expect(xml).toContain('<Button Id="Mscrm.HomepageGrid.account.MainTab.Actions.Controls.DeleteAccount"');
	});

	it("does NOT generate HideCustomAction for a button already hidden in baseline", () => {
		const buttonId = "Mscrm.HomepageGrid.account.Tab.Group.Button";
		const baseline: RibbonDefinition = {
			location: "HomepageGrid",
			entityLogicalName: "account",
			tabs: [
				{
					id: "Tab1",
					label: "Tab",
					sequence: 10,
					tabDisplayRules: [],
					groups: [
						{
							id: "Group1",
							label: "Group",
							sequence: 10,
							template: "",
							buttons: [
								{
									id: buttonId,
									label: "Label",
									kind: "button",
									sequence: 10,
									templateAlias: "o1",
									commandId: "",
									hidden: true,
									oob: true,
									custom: false,
									managed: false,
								},
							],
						},
					],
				},
			],
		};
		const current: RibbonDefinition = {
			...baseline,
			tabs: baseline.tabs.map((t) => ({
				...t,
				groups: t.groups.map((g) => ({
					...g,
					buttons: g.buttons.map((b) => ({ ...b })),
				})),
			})),
		};
		const xml = generateRibbonDiffXml(makeInput(current, baseline));
		expect(xml).not.toContain("HideCustomAction");
	});
});

// ── generateRibbonDiffXml — OOB override ──────────────────────────────────

describe("generateRibbonDiffXml — OOB override CustomAction", () => {
	it("generates override CustomAction when an OOB button has been modified", () => {
		// Baseline: an OOB button with default icon and command.
		const baseline: RibbonDefinition = {
			location: "HomepageGrid",
			entityLogicalName: "account",
			tabs: [
				{
					id: "Tab1",
					label: "Tab",
					sequence: 10,
					tabDisplayRules: [],
					groups: [
						{
							id: "Group1",
							label: "Group",
							sequence: 10,
							template: "",
							buttons: [
								{
									id: "Mscrm.HomepageGrid.account.MainTab.New.Controls.NewRecord",
									label: "New",
									icon: "add_16_regular",
									kind: "button",
									sequence: 10,
									templateAlias: "o1",
									commandId: "Mscrm.HomepageGrid.account.NewRecord",
									hidden: false,
									oob: true,
									custom: false,
									managed: false,
								},
							],
						},
					],
				},
			],
		};
		// Current: same button, but the icon AND the command have been changed.
		// This is the canonical "override an OOB button" scenario — the bug
		// before this test was that property changes to OOB buttons produced
		// ZERO diff and silently disappeared on publish.
		const current: RibbonDefinition = JSON.parse(JSON.stringify(baseline));
		const target = current.tabs[0].groups[0].buttons[0];
		// Icons must reference real web resources — a bare Fluent name is invalid.
		target.image32 = "$webresource:contoso_/icons/rocket.svg";
		target.commandId = "Contoso.Override.Command";

		const xml = generateRibbonDiffXml({
			...makeInput(current),
			baseline,
		});
		expect(xml).toContain("CustomAction");
		// The override Location attribute points to the OOB button's ID
		// (Microsoft documented pattern for "change definition of existing item").
		expect(xml).toContain('Location="Mscrm.HomepageGrid.account.MainTab.New.Controls.NewRecord"');
		// And carries the new icon (as a web-resource ModernImage) + command through.
		expect(xml).toContain('ModernImage="$webresource:contoso_/icons/rocket.svg"');
		expect(xml).toContain('Image32by32="$webresource:contoso_/icons/rocket.svg"');
		expect(xml).toContain('Command="Contoso.Override.Command"');
	});

	it("does NOT emit any override when an OOB button is unchanged from baseline", () => {
		const baseline: RibbonDefinition = {
			location: "HomepageGrid",
			entityLogicalName: "account",
			tabs: [
				{
					id: "Tab1",
					label: "Tab",
					sequence: 10,
					tabDisplayRules: [],
					groups: [
						{
							id: "Group1",
							label: "Group",
							sequence: 10,
							template: "",
							buttons: [
								{
									id: "Mscrm.HomepageGrid.account.MainTab.New.Controls.NewRecord",
									label: "New",
									icon: "add_16_regular",
									kind: "button",
									sequence: 10,
									templateAlias: "o1",
									commandId: "Mscrm.HomepageGrid.account.NewRecord",
									hidden: false,
									oob: true,
									custom: false,
									managed: false,
								},
							],
						},
					],
				},
			],
		};
		const current: RibbonDefinition = JSON.parse(JSON.stringify(baseline));
		const xml = generateRibbonDiffXml({ ...makeInput(current), baseline });
		// Empty <CustomActions/> section — no overrides, no new buttons.
		expect(xml).not.toContain("<CustomAction Id=");
	});
});

// ── generateRibbonDiffXml — customization-scoped emission (RW parity) ──────

/**
 * Asserts the Ribbon Workbench invariant: every `$LocLabels:<id>` reference in
 * the output has a matching `<LocLabel Id="<id>">` definition. A dangling
 * reference is the #1 documented cause of "publish succeeds but the button
 * never appears" (the ribbon-metadata compile fails to resolve the label).
 */
function expectNoDanglingLocLabelRefs(xml: string) {
	const refs = [...xml.matchAll(/\$LocLabels:([^"&<\s]+)/g)].map((m) => m[1]);
	const defs = new Set([...xml.matchAll(/<LocLabel\s+Id="([^"]+)"/g)].map((m) => m[1]));
	for (const ref of refs) {
		expect(defs.has(ref), `LocLabel "${ref}" referenced but not defined`).toBe(true);
	}
}

function button(over: Partial<import("@/types/ribbon").RibbonButton>) {
	return {
		id: "id",
		label: "Label",
		kind: "button" as const,
		sequence: 10,
		templateAlias: "o1",
		commandId: "",
		hidden: false,
		oob: false,
		custom: true,
		managed: false,
		...over,
	};
}

describe("generateRibbonDiffXml — customization-scoped emission", () => {
	// A realistic loaded ribbon: one OOB button (present in BOTH baseline and
	// current, untouched) plus one user-created custom button.
	const oobButton = button({
		id: "Mscrm.Form.account.MainTab.Save.SavePrimary",
		label: "Save",
		commandId: "Mscrm.SavePrimary",
		oob: true,
		custom: false,
	});
	const customButton = button({
		id: "mxrm.account.MyButton.Button",
		label: "My Button",
		commandId: "mxrm.account.MyButton.Command",
		oob: false,
		custom: true,
	});

	function ribbonWith(buttons: import("@/types/ribbon").RibbonButton[]): RibbonDefinition {
		return {
			location: "Form",
			entityLogicalName: "account",
			tabs: [
				{
					id: "Mscrm.Form.account.MainTab",
					label: "Main",
					sequence: 10,
					tabDisplayRules: [],
					groups: [
						{
							id: "Mscrm.Form.account.MainTab.Save",
							label: "Save",
							sequence: 10,
							template: "Mscrm.Templates.Flexible2",
							buttons,
						},
					],
				},
			],
		};
	}

	const commands: CommandDefinition[] = [
		// System command (OOB) — must NOT be re-emitted.
		{ id: "Mscrm.SavePrimary", enableRules: ["Mscrm.CanSavePrimary"], displayRules: [], actions: [] },
		// Custom command — MUST be emitted.
		{
			id: "mxrm.account.MyButton.Command",
			enableRules: [],
			displayRules: [],
			actions: [{ kind: "url", address: "https://example.com/x", passParams: false, params: [] }],
		},
	];

	// Change-based model: a NEW custom button (present in `current`, absent from
	// the loaded `baseline`) is what gets emitted. The untouched OOB button sits
	// in both and must NOT be touched.
	it("does NOT dump OOB commands referenced only by untouched OOB buttons", () => {
		const baseline = ribbonWith([oobButton]);
		const current = ribbonWith([oobButton, customButton]); // user added customButton
		const xml = generateRibbonDiffXml(makeInput(current, baseline, commands));
		expect(xml).not.toContain('Id="Mscrm.SavePrimary"');
		expect(xml).not.toContain("Mscrm.CanSavePrimary");
	});

	it("emits a new custom button's CustomAction + its command, scoped to the change", () => {
		const baseline = ribbonWith([oobButton]);
		const current = ribbonWith([oobButton, customButton]);
		const xml = generateRibbonDiffXml(makeInput(current, baseline, commands));
		expect(xml).toContain('Id="mxrm.account.MyButton.Button.CustomAction"');
		expect(xml).toContain('Location="Mscrm.Form.account.MainTab.Save.Controls._children"');
		expect(xml).toContain('Id="mxrm.account.MyButton.Command"');
	});

	it("does NOT re-emit an unchanged button (any provenance) — additive import keeps it", () => {
		// baseline == current → nothing changed → empty diff, no re-dump.
		const baseline = ribbonWith([oobButton, customButton]);
		const current = ribbonWith([oobButton, customButton]);
		const xml = generateRibbonDiffXml(makeInput(current, baseline, commands));
		expect(xml).not.toContain("<CustomAction Id=");
		expect(xml).not.toContain('Id="mxrm.account.MyButton.Command"'); // no orphan command
	});

	it("does NOT emit a CustomAction for an untouched OOB button", () => {
		const baseline = ribbonWith([oobButton]);
		const current = ribbonWith([oobButton, customButton]);
		const xml = generateRibbonDiffXml(makeInput(current, baseline, commands));
		expect(xml).not.toContain('Id="Mscrm.Form.account.MainTab.Save.SavePrimary.CustomAction"');
	});

	it("emits a backing LocLabel for a plain-text custom button label (no dangling ref)", () => {
		const baseline = ribbonWith([oobButton]);
		const current = ribbonWith([oobButton, customButton]);
		const xml = generateRibbonDiffXml(makeInput(current, baseline, commands));
		expect(xml).toContain('LabelText="$LocLabels:mxrm.account.MyButton.Button.LabelText"');
		expect(xml).toContain('<LocLabel Id="mxrm.account.MyButton.Button.LabelText"');
		expect(xml).toContain('description="My Button"');
		expectNoDanglingLocLabelRefs(xml);
	});

	it("merges extra-language titles from the store into the emitted LocLabel", () => {
		const baseline = ribbonWith([oobButton]);
		const current = ribbonWith([oobButton, customButton]);
		const locLabels: LocLabel[] = [
			{
				id: "mxrm.account.MyButton.Button.LabelText",
				titles: [
					{ languageCode: 1033, description: "ignored — button.label wins for 1033" },
					{ languageCode: 1036, description: "Mon bouton" },
				],
			},
		];
		const xml = generateRibbonDiffXml(makeInput(current, baseline, commands, [], [], locLabels));
		expect(xml).toContain('description="My Button"'); // 1033 from button.label
		expect(xml).toContain('languagecode="1036"');
		expect(xml).toContain('description="Mon bouton"');
		expectNoDanglingLocLabelRefs(xml);
	});

	it("does NOT redefine a system command kept on an OOB override", () => {
		// User changes only the icon of an OOB button but keeps its Mscrm command.
		const baseline = ribbonWith([oobButton]);
		const current = ribbonWith([button({ ...oobButton, icon: "rocket_16_regular" })]);
		const xml = generateRibbonDiffXml(makeInput(current, baseline, commands));
		// Override CustomAction is emitted…
		expect(xml).toContain('Id="Mscrm.Form.account.MainTab.Save.SavePrimary.Override.CustomAction"');
		// …but the system command is referenced, never redefined.
		expect(xml).not.toContain('<CommandDefinition Id="Mscrm.SavePrimary"');
	});
});

describe("generateRibbonDiffXml — new groups and tabs", () => {
	const newButton = button({
		id: "mxrm.account.NewBtn.Button",
		label: "New Btn",
		commandId: "",
		custom: true,
	});

	it("emits a group CustomAction for a new group in an existing tab", () => {
		const baseline: RibbonDefinition = {
			location: "Form",
			entityLogicalName: "account",
			tabs: [
				{ id: "Mscrm.Form.account.MainTab", label: "Main", sequence: 10, tabDisplayRules: [], groups: [] },
			],
		};
		const current: RibbonDefinition = {
			location: "Form",
			entityLogicalName: "account",
			tabs: [
				{
					id: "Mscrm.Form.account.MainTab",
					label: "Main",
					sequence: 10,
					tabDisplayRules: [],
					groups: [
						{
							id: "mxrm.account.MyGroup",
							label: "My Group",
							sequence: 20,
							template: "Flexible2",
							buttons: [newButton],
						},
					],
				},
			],
		};
		const xml = generateRibbonDiffXml(makeInput(current, baseline));
		// Group is created at the documented Groups._children anchor…
		expect(xml).toContain('Location="Mscrm.Form.account.MainTab.Groups._children"');
		expect(xml).toContain('<Group Id="mxrm.account.MyGroup"');
		// short template name is qualified
		expect(xml).toContain('Template="Mscrm.Templates.Flexible2"');
		// …and the button inside it anchors to the new group's controls.
		expect(xml).toContain('Location="mxrm.account.MyGroup.Controls._children"');
		expectNoDanglingLocLabelRefs(xml);
	});

	it("emits a tab CustomAction at Mscrm.Tabs._children for a new tab", () => {
		const baseline: RibbonDefinition = { location: "Form", entityLogicalName: "account", tabs: [] };
		const current: RibbonDefinition = {
			location: "Form",
			entityLogicalName: "account",
			tabs: [
				{
					id: "mxrm.account.MyTab",
					label: "My Tab",
					sequence: 30,
					tabDisplayRules: [],
					groups: [
						{
							id: "mxrm.account.MyTab.Group",
							label: "Grp",
							sequence: 10,
							template: "Flexible2",
							buttons: [newButton],
						},
					],
				},
			],
		};
		const xml = generateRibbonDiffXml(makeInput(current, baseline));
		expect(xml).toContain('Location="Mscrm.Tabs._children"');
		expect(xml).toContain('<Tab Id="mxrm.account.MyTab"');
		expect(xml).toContain('<Group Id="mxrm.account.MyTab.Group"');
		// new-tab groups are emitted inline, NOT also as standalone group actions
		expect(xml).not.toContain('Location="mxrm.account.MyTab.Groups._children"');
		expectNoDanglingLocLabelRefs(xml);
	});
});

// ── parse → generate round-trip (loaded custom button survives republish) ──

describe("generateRibbonDiffXml — parse→generate round-trip", () => {
	// A merged entity ribbon (as returned by RetrieveEntityRibbon) containing a
	// single user CustomAction: a custom button whose label is a $LocLabels ref.
	const mergedRibbon = `<?xml version="1.0" encoding="utf-8"?>
<RibbonDefinitions>
  <RibbonDefinition>
    <Tabs>
      <Tab Id="Mscrm.Form.account.MainTab" Title="Main" Sequence="10">
        <Groups>
          <Group Id="Mscrm.Form.account.MainTab.Save" Title="Save" Sequence="10" Template="Mscrm.Templates.Flexible2">
            <Controls>
              <Button Id="mxrm.account.Button.MyButton" Command="mxrm.account.Command.Command" LabelText="$LocLabels:mxrm.account.Button.MyButton.LabelText" TemplateAlias="o1" Sequence="10"/>
            </Controls>
          </Group>
        </Groups>
      </Tab>
    </Tabs>
    <CustomActions>
      <CustomAction Id="mxrm.account.Button.MyButton.CustomAction" Location="Mscrm.Form.account.MainTab.Save.Controls._children" Sequence="10">
        <CommandUIDefinition>
          <Button Id="mxrm.account.Button.MyButton" Command="mxrm.account.Command.Command" LabelText="$LocLabels:mxrm.account.Button.MyButton.LabelText" TemplateAlias="o1" Sequence="10"/>
        </CommandUIDefinition>
      </CustomAction>
    </CustomActions>
    <CommandDefinitions>
      <CommandDefinition Id="mxrm.account.Command.Command">
        <EnableRules/>
        <DisplayRules/>
        <Actions><Url Address="https://example.com/x"/></Actions>
      </CommandDefinition>
    </CommandDefinitions>
    <RuleDefinitions/>
    <LocLabels>
      <LocLabel Id="mxrm.account.Button.MyButton.LabelText">
        <Titles><Title languagecode="1033" description="My Button"/></Titles>
      </LocLabel>
    </LocLabels>
  </RibbonDefinition>
</RibbonDefinitions>`;

	it("resolves a loaded custom button's label and (change-based) leaves it alone when unchanged", () => {
		const parsed = parseRibbonXml(mergedRibbon, "Form", "account");
		const btn = parsed.ribbon.tabs[0].groups[0].buttons[0];
		// Parser resolves the $LocLabels ref to human text (not the loc-label id).
		expect(btn.label).toBe("My Button");

		// baseline == current → the already-live custom button is unchanged, so
		// the diff is empty (additive import keeps it; no re-dump, no orphan).
		const unchanged = generateRibbonDiffXml({
			current: parsed.ribbon,
			baseline: parsed.ribbon,
			commands: parsed.commands,
			enableRules: parsed.enableRules,
			displayRules: parsed.displayRules,
			locLabels: parsed.locLabels,
			entityLogicalName: "account",
			location: "Form",
		});
		expect(unchanged).not.toContain("<CustomAction Id=");

		// Now add a NEW button to the loaded ribbon → only THAT is emitted, with
		// a proper backing LocLabel and its command; the pre-existing button and
		// any OOB commands are untouched.
		const current: RibbonDefinition = JSON.parse(JSON.stringify(parsed.ribbon));
		current.tabs[0].groups[0].buttons.push({
			id: "mxrm.account.Button.Second",
			label: "Second",
			kind: "button",
			sequence: 20,
			templateAlias: "o1",
			commandId: "mxrm.account.Second.Command",
			hidden: false,
			oob: false,
			custom: true,
			managed: false,
		});
		const commands = [
			...parsed.commands,
			{ id: "mxrm.account.Second.Command", enableRules: [], displayRules: [], actions: [] },
		];
		const xml = generateRibbonDiffXml({
			current,
			baseline: parsed.ribbon,
			commands,
			enableRules: parsed.enableRules,
			displayRules: parsed.displayRules,
			locLabels: parsed.locLabels,
			entityLogicalName: "account",
			location: "Form",
		});
		expect(xml).toContain('Id="mxrm.account.Button.Second.CustomAction"');
		expect(xml).toContain('<LocLabel Id="mxrm.account.Button.Second.LabelText"');
		expect(xml).toContain('description="Second"');
		// pre-existing custom button NOT re-emitted (unchanged)
		expect(xml).not.toContain('Id="mxrm.account.Button.MyButton.CustomAction"');
		expectNoDanglingLocLabelRefs(xml);
	});
});

// ── generateRibbonDiffXml — delta-only output ──────────────────────────────

describe("generateRibbonDiffXml — delta only", () => {
	it("produces valid XML parseable by DOMParser", () => {
		const xml = generateRibbonDiffXml(
			makeInput({
				location: "HomepageGrid",
				entityLogicalName: "account",
				tabs: [],
			}),
		);
		const parser = new DOMParser();
		const doc = parser.parseFromString(xml, "application/xml");
		expect(doc.querySelector("parsererror")).toBeNull();
	});

	it("wraps RibbonDiffXml in entity customizations path via wrapInCustomizationsXml", () => {
		const xml = "<RibbonDiffXml/>";
		const wrapped = wrapInCustomizationsXml(xml, "account", "entity");
		expect(wrapped).toContain("ImportExportXml");
		expect(wrapped).toContain("account");
	});

	it("does NOT include an <?xml ?> declaration (it's a fragment, not a document)", () => {
		// Regression test for 0x8004801a "Unexpected XML declaration" — the
		// fragment is embedded inside customizations.xml at publish time, and
		// XML forbids a second declaration inside an already-open document.
		const xml = generateRibbonDiffXml(
			makeInput({
				location: "HomepageGrid",
				entityLogicalName: "account",
				tabs: [],
			}),
		);
		expect(xml.trimStart().startsWith("<RibbonDiffXml")).toBe(true);
		expect(xml).not.toContain("<?xml");
	});

	it("produces a wrapped document that contains exactly one <?xml ?> declaration", () => {
		const fragment = generateRibbonDiffXml(
			makeInput({
				location: "HomepageGrid",
				entityLogicalName: "account",
				tabs: [],
			}),
		);
		const wrapped = wrapInCustomizationsXml(fragment, "account", "entity");
		const declarations = wrapped.match(/<\?xml/g) ?? [];
		expect(declarations.length).toBe(1);
		// And the single declaration must be the very first non-whitespace.
		expect(wrapped.trimStart().startsWith("<?xml")).toBe(true);
	});
});
