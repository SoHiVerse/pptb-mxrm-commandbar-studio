import { describe, expect, it } from "vitest";
import { canonicalizeXml, mergeRibbonDiffXml } from "@/services/ribbonMerge";
import type { RibbonDelta } from "@/types/workspace";

const source = `<RibbonDiffXml Vendor="untouched">
  <CustomActions>
    <CustomAction Id="unusual_8a8a" Location="Group.Controls._children" Sequence="20" VendorAction="preserve">
      <CommandUIDefinition>
        <FlyoutAnchor Id="Menu" Legacy="preserve">
          <Menu Id="Menu.Menu"><MenuSection Id="section"><Controls>
            <Button Id="A" Command="cmd.A" LabelText="A" CustomAttribute="keep"/>
            <Button Id="B" Command="cmd.B" LabelText="B"/>
          </Controls></MenuSection></Menu>
        </FlyoutAnchor>
      </CommandUIDefinition>
      <VendorExtension Kind="keep"/>
    </CustomAction>
    <CustomAction Id="unusual_other" Location="Other.Controls._children" Sequence="30"><CommandUIDefinition><Button Id="C" Command="cmd.C" LabelText="C"/></CommandUIDefinition></CustomAction>
    <HideCustomAction HideActionId="LegacyHide" Location="Hidden"/>
  </CustomActions>
  <CommandDefinitions>
    <CommandDefinition Id="cmd.A"><EnableRules/><DisplayRules/><Actions><Url Address="/a"/></Actions></CommandDefinition>
    <CommandDefinition Id="cmd.B"><EnableRules/><DisplayRules/><Actions><Url Address="/b"/></Actions></CommandDefinition>
    <CommandDefinition Id="cmd.C"><EnableRules/><DisplayRules/><Actions><Url Address="/c"/></Actions></CommandDefinition>
  </CommandDefinitions>
  <RuleDefinitions>
    <TabDisplayRules><TabDisplayRule TabCommand="Tab.One"><DisplayRules><DisplayRule Id="rule.display"/></DisplayRules></TabDisplayRule></TabDisplayRules>
    <DisplayRules><DisplayRule Id="rule.display"><EntityRule EntityName="account"/></DisplayRule></DisplayRules>
    <EnableRules><EnableRule Id="rule.enable"><SelectionCountRule Minimum="1"/></EnableRule></EnableRules>
  </RuleDefinitions>
  <Scalings><Scaling TabId="Tab.One"><Scale GroupId="G" Size="Large" Sequence="1"/></Scaling></Scalings>
  <LocLabels><LocLabel Id="label.A"><Titles><Title languagecode="1033" description="A"/></Titles></LocLabel></LocLabels>
  <UnknownSection Feature="preserve"><Odd/></UnknownSection>
</RibbonDiffXml>`;

const empty: Omit<RibbonDelta, "xml"> = {
	removedControlIds: [], removedGroupIds: [], removedTabIds: [],
	unhiddenControlIds: [], removedCommandIds: [],
	removedEnableRuleIds: [], removedDisplayRuleIds: [], removedLocLabelIds: [],
	removedTabDisplayRuleCommands: [], removedScalingTabIds: [],
};

function delta(xml = "<RibbonDiffXml/>", removals: Partial<Omit<RibbonDelta, "xml">> = {}): RibbonDelta {
	return { xml, ...empty, ...removals };
}

function parse(xml: string): Document {
	const doc = new DOMParser().parseFromString(xml, "application/xml");
	expect(doc.querySelector("parsererror")).toBeNull();
	return doc;
}

describe("mergeRibbonDiffXml", () => {
	it("retains an earlier A action, definitions and unknown vendor XML when adding B", () => {
		const merged = parse(mergeRibbonDiffXml(source, [delta(`<RibbonDiffXml><CustomActions>
      <CustomAction Id="D.CustomAction" Location="Other.Controls._children" Sequence="40"><CommandUIDefinition><Button Id="D" Command="cmd.D" LabelText="D"/></CommandUIDefinition></CustomAction>
    </CustomActions><CommandDefinitions><CommandDefinition Id="cmd.D"><Actions><Url Address="/d"/></Actions></CommandDefinition></CommandDefinitions></RibbonDiffXml>`)]));
		expect(merged.querySelector('Button[Id="A"]')?.getAttribute("Command")).toBe("cmd.A");
		expect(merged.querySelector('Button[Id="D"]')).not.toBeNull();
		expect(merged.querySelector('CommandDefinition[Id="cmd.A"]')).not.toBeNull();
		expect(merged.querySelector('CustomAction[Id="unusual_8a8a"]')?.getAttribute("VendorAction")).toBe("preserve");
		expect(merged.querySelector('UnknownSection[Feature="preserve"] Odd')).not.toBeNull();
	});

	it("updates a nested control in place, retaining its original action ID, siblings, parent menu and unknown attributes", () => {
		const merged = parse(mergeRibbonDiffXml(source, [delta(`<RibbonDiffXml><CustomActions>
      <CustomAction Id="B.NewSyntheticAction" Location="Group.Controls._children" Sequence="20"><CommandUIDefinition><Button Id="B" Command="cmd.B" LabelText="B updated"/></CommandUIDefinition></CustomAction>
    </CustomActions></RibbonDiffXml>`)]));
		expect(merged.querySelectorAll("CustomAction")).toHaveLength(2);
		expect(merged.querySelector('CustomAction[Id="B.NewSyntheticAction"]')).toBeNull();
		expect(merged.querySelector('CustomAction[Id="unusual_8a8a"] Menu Controls Button[Id="A"]')?.getAttribute("CustomAttribute")).toBe("keep");
		expect(merged.querySelector('CustomAction[Id="unusual_8a8a"] Menu Controls Button[Id="B"]')?.getAttribute("LabelText")).toBe("B updated");
		expect(merged.querySelector('CustomAction[Id="unusual_8a8a"] VendorExtension')).not.toBeNull();
	});

	it("resolves an override whose Location names the existing control, preserving the source action and nesting", () => {
		const merged = parse(mergeRibbonDiffXml(source, [delta(`<RibbonDiffXml><CustomActions>
      <CustomAction Id="B.Override.CustomAction" Location="B" Sequence="30"><CommandUIDefinition><Button Id="B" Command="cmd.B" LabelText="Overridden"/></CommandUIDefinition></CustomAction>
    </CustomActions></RibbonDiffXml>`)]));
		expect(merged.querySelectorAll("CustomAction")).toHaveLength(2);
		expect(merged.querySelector('CustomAction[Id="unusual_8a8a"] Menu Button[Id="B"]')?.getAttribute("LabelText")).toBe("Overridden");
		expect(merged.querySelector('CustomAction[Id="unusual_8a8a"]')?.getAttribute("Location")).toBe("Group.Controls._children");
	});

	it("clears deliberately omitted standard button attributes while retaining vendor attributes", () => {
		const merged = parse(mergeRibbonDiffXml(source, [delta(`<RibbonDiffXml><CustomActions>
      <CustomAction Id="A.Override" Location="A" Sequence="20"><CommandUIDefinition><Button Id="A" LabelText="Updated"/></CommandUIDefinition></CustomAction>
    </CustomActions></RibbonDiffXml>`)]));
		const button = merged.querySelector('Button[Id="A"]');
		expect(button?.hasAttribute("Command")).toBe(false);
		expect(button?.getAttribute("CustomAttribute")).toBe("keep");
	});

	it("updates only the selected rule definition without losing other rules", () => {
		const merged = parse(mergeRibbonDiffXml(source, [delta('<RibbonDiffXml><RuleDefinitions><EnableRules><EnableRule Id="rule.enable"><SelectionCountRule Minimum="3"/></EnableRule></EnableRules></RuleDefinitions></RibbonDiffXml>')]));
		expect(merged.querySelector('EnableRule[Id="rule.enable"] SelectionCountRule')?.getAttribute("Minimum")).toBe("3");
		expect(merged.querySelector('DisplayRules > DisplayRule[Id="rule.display"]')).not.toBeNull();
	});

	it("replaces edited command actions as a complete ordered definition with deletions", () => {
		const original = source.replace('<Actions><Url Address="/a"/></Actions>',
			'<Actions><Url Address="/first"/><JavaScriptFunction FunctionName="old" Library="$webresource:library"/><Url Address="/last"/></Actions>');
		const edited = delta('<RibbonDiffXml><CommandDefinitions><CommandDefinition Id="cmd.A"><EnableRules/><DisplayRules/><Actions><JavaScriptFunction FunctionName="new" Library="$webresource:library"/><Url Address="/last"/></Actions></CommandDefinition></CommandDefinitions></RibbonDiffXml>');
		const merged = parse(mergeRibbonDiffXml(original, [edited]));
		const actions = Array.from(merged.querySelector('CommandDefinition[Id="cmd.A"] > Actions')!.children);
		expect(actions.map(node => node.tagName)).toEqual(["JavaScriptFunction", "Url"]);
		expect(actions[0].getAttribute("FunctionName")).toBe("new");
		expect(actions[1].getAttribute("Address")).toBe("/last");
		expect(merged.querySelector('CommandDefinition[Id="cmd.B"] Url')?.getAttribute("Address")).toBe("/b");
	});

	it("replaces edited enable-rule steps, removing old steps and obsolete optional attributes", () => {
		const original = source.replace('<SelectionCountRule Minimum="1"/>', '<SelectionCountRule Minimum="1" Maximum="5"/><EntityRule EntityName="account"/>');
		const edited = delta('<RibbonDiffXml><RuleDefinitions><EnableRules><EnableRule Id="rule.enable"><SelectionCountRule Minimum="2"/></EnableRule></EnableRules></RuleDefinitions></RibbonDiffXml>');
		const merged = parse(mergeRibbonDiffXml(original, [edited]));
		const rule = merged.querySelector('RuleDefinitions > EnableRules > EnableRule[Id="rule.enable"]')!;
		expect(rule.querySelectorAll(":scope > *")).toHaveLength(1);
		expect(rule.querySelector("SelectionCountRule")?.getAttribute("Minimum")).toBe("2");
		expect(rule.querySelector("SelectionCountRule")?.hasAttribute("Maximum")).toBe(false);
	});

	it("replaces localized-title collection when a language is deliberately removed", () => {
		const original = source.replace('<Title languagecode="1033" description="A"/>', '<Title languagecode="1033" description="A"/><Title languagecode="1036" description="Ancien"/>');
		const edited = delta('<RibbonDiffXml><LocLabels><LocLabel Id="label.A"><Titles><Title languagecode="1033" description="Updated"/></Titles></LocLabel></LocLabels></RibbonDiffXml>');
		const merged = parse(mergeRibbonDiffXml(original, [edited]));
		const titles = merged.querySelectorAll('LocLabel[Id="label.A"] > Titles > Title');
		expect(titles).toHaveLength(1);
		expect(titles[0].getAttribute("description")).toBe("Updated");
	});

	it("allows safe command changes when the generated definition retains unknown original action XML", () => {
		const withExtension = source.replace('<Actions><Url Address="/a"/></Actions>', '<Actions><VendorAction Key="keep"/><Url Address="/a"/></Actions>');
		const next = delta('<RibbonDiffXml><CommandDefinitions><CommandDefinition Id="cmd.A"><EnableRules/><DisplayRules/><Actions><VendorAction Key="keep"/><Url Address="/updated"/></Actions></CommandDefinition></CommandDefinitions></RibbonDiffXml>');
		const merged = parse(mergeRibbonDiffXml(withExtension, [next]));
		expect(merged.querySelector('CommandDefinition[Id="cmd.A"] VendorAction')?.getAttribute("Key")).toBe("keep");
		expect(merged.querySelector('CommandDefinition[Id="cmd.A"] Url')?.getAttribute("Address")).toBe("/updated");
	});

	it("rejects edits that would discard unrecognized original command actions or rule steps", () => {
		const withExtension = source.replace('<Actions><Url Address="/a"/></Actions>', '<Actions><VendorAction Key="keep"/><Url Address="/a"/></Actions>');
		const unsafe = delta('<RibbonDiffXml><CommandDefinitions><CommandDefinition Id="cmd.A"><Actions><Url Address="/updated"/></Actions></CommandDefinition></CommandDefinitions></RibbonDiffXml>');
		expect(() => mergeRibbonDiffXml(withExtension, [unsafe])).toThrow(/unsupported|preserv/i);
		const withRule = source.replace('<SelectionCountRule Minimum="1"/>', '<VendorRule Key="keep"/><SelectionCountRule Minimum="1"/>');
		const lostRule = delta('<RibbonDiffXml><RuleDefinitions><EnableRules><EnableRule Id="rule.enable"><SelectionCountRule Minimum="3"/></EnableRule></EnableRules></RuleDefinitions></RibbonDiffXml>');
		expect(() => mergeRibbonDiffXml(withRule, [lostRule])).toThrow(/unsupported|preserv/i);
	});

	it("moves a nested control with explicit removal and addition, retaining the original nested siblings", () => {
		const merged = parse(mergeRibbonDiffXml(source, [delta(`<RibbonDiffXml><CustomActions>
      <CustomAction Id="B.Move.CustomAction" Location="Destination.Controls._children" Sequence="90"><CommandUIDefinition><Button Id="B" Command="cmd.B" LabelText="Moved" Sequence="90"/></CommandUIDefinition></CustomAction>
    </CustomActions></RibbonDiffXml>`, { removedControlIds: ["B"] })]));
		expect(merged.querySelector('CustomAction[Id="unusual_8a8a"] Menu Button[Id="A"]')).not.toBeNull();
		expect(merged.querySelector('CustomAction[Id="unusual_8a8a"] Menu Button[Id="B"]')).toBeNull();
		expect(merged.querySelector('CustomAction[Id="B.Move.CustomAction"][Location="Destination.Controls._children"] Button[Id="B"]')).not.toBeNull();
		expect(merged.querySelectorAll('Button[Id="B"]')).toHaveLength(1);
	});

	it("moves a direct control by updating Location and Sequence without renaming its original custom action", () => {
		const merged = parse(mergeRibbonDiffXml(source, [delta(`<RibbonDiffXml><CustomActions><CustomAction Id="C.MoveAction" Location="Moved.Controls._children" Sequence="77"><CommandUIDefinition><Button Id="C" Command="cmd.C" Sequence="77" LabelText="C"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>`, { removedControlIds: ["C"] })]));
		const action = merged.querySelector('CustomAction[Id="unusual_other"]');
		expect(action?.getAttribute("Location")).toBe("Moved.Controls._children");
		expect(action?.getAttribute("Sequence")).toBe("77");
		expect(merged.querySelector('CustomAction[Id="C.MoveAction"]')).toBeNull();
	});

	it("changes action and button sequence when reordering a directly-owned existing control", () => {
		const merged = parse(mergeRibbonDiffXml(source, [delta(`<RibbonDiffXml><CustomActions><CustomAction Id="C.Override" Location="C" Sequence="75"><CommandUIDefinition><Button Id="C" Command="cmd.C" LabelText="C" Sequence="75"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>`)]));
		expect(merged.querySelector('CustomAction[Id="unusual_other"]')?.getAttribute("Sequence")).toBe("75");
		expect(merged.querySelector('Button[Id="C"]')?.getAttribute("Sequence")).toBe("75");
	});

	it("deletes only a selected nested control and leaves its siblings and enclosing action", () => {
		const merged = parse(mergeRibbonDiffXml(source, [delta(undefined, { removedControlIds: ["B"] })]));
		expect(merged.querySelector('Button[Id="B"]')).toBeNull();
		expect(merged.querySelector('Button[Id="A"]')).not.toBeNull();
		expect(merged.querySelector('CustomAction[Id="unusual_8a8a"] VendorExtension')).not.toBeNull();
	});

	it("removes a selected nested group or tab without deleting another branch of its action", () => {
		const tabs = '<RibbonDiffXml><CustomActions><CustomAction Id="Shared" Location="Mscrm.Tabs._children"><CommandUIDefinition><Ribbon><Tabs><Tab Id="T1"><Groups><Group Id="G1"/></Groups></Tab><Tab Id="T2"/></Tabs></Ribbon></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>';
		const merged = parse(mergeRibbonDiffXml(tabs, [delta(undefined, { removedGroupIds: ["G1"], removedTabIds: ["T2"] })]));
		expect(merged.querySelector('Tab[Id="T1"]')).not.toBeNull();
		expect(merged.querySelector('Tab[Id="T2"]')).toBeNull();
		expect(merged.querySelector('Group[Id="G1"]')).toBeNull();
	});

	it("removes the action when the only nested tab is deleted and no other action content remains", () => {
		const xml = '<RibbonDiffXml><CustomActions><CustomAction Id="OnlyTab" Location="Mscrm.Tabs._children"><CommandUIDefinition><Ribbon><Tabs><Tab Id="T1"/></Tabs></Ribbon></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>';
		const merged = parse(mergeRibbonDiffXml(xml, [delta(undefined, { removedTabIds: ["T1"] })]));
		expect(merged.querySelector('CustomAction[Id="OnlyTab"]')).toBeNull();
	});

	it("removes a top-level action with its last control and clears explicit hide/unhide intent", () => {
		const merged = parse(mergeRibbonDiffXml(source, [delta(undefined, { removedControlIds: ["C"], unhiddenControlIds: ["Hidden"] })]));
		expect(merged.querySelector('CustomAction[Id="unusual_other"]')).toBeNull();
		expect(merged.querySelector('HideCustomAction[Location="Hidden"]')).toBeNull();
	});

	it("upserts hides by Location instead of creating duplicate or renaming existing hide actions", () => {
		const merged = parse(mergeRibbonDiffXml(source, [delta('<RibbonDiffXml><CustomActions><HideCustomAction HideActionId="Hidden.New" Location="Hidden"/><HideCustomAction HideActionId="Hide.A" Location="A"/></CustomActions></RibbonDiffXml>')]));
		expect(merged.querySelectorAll('HideCustomAction[Location="Hidden"]')).toHaveLength(1);
		expect(merged.querySelector('HideCustomAction[Location="Hidden"]')?.getAttribute("HideActionId")).toBe("LegacyHide");
		expect(merged.querySelector('HideCustomAction[Location="A"]')).not.toBeNull();
	});

	it("deletes unreferenced definitions, tab display rules and scaling without altering neighboring declarations", () => {
		const merged = parse(mergeRibbonDiffXml(source, [delta(undefined, {
			removedCommandIds: ["cmd.C"], removedEnableRuleIds: ["rule.enable"],
			removedTabDisplayRuleCommands: ["Tab.One"], removedScalingTabIds: ["Tab.One"],
			removedControlIds: ["C"],
		})]));
		expect(merged.querySelector('CommandDefinition[Id="cmd.C"]')).toBeNull();
		expect(merged.querySelector('CommandDefinition[Id="cmd.A"]')).not.toBeNull();
		expect(merged.querySelector('EnableRules > EnableRule[Id="rule.enable"]')).toBeNull();
		expect(merged.querySelector('TabDisplayRule[TabCommand="Tab.One"]')).toBeNull();
		expect(merged.querySelector('Scaling[TabId="Tab.One"]')).toBeNull();
	});

	it("removes a display rule and the tab display rule that referenced it in one operation", () => {
		const merged = parse(mergeRibbonDiffXml(source, [delta(undefined, {
			removedDisplayRuleIds: ["rule.display"], removedTabDisplayRuleCommands: ["Tab.One"],
		})]));
		expect(merged.querySelector('DisplayRules > DisplayRule[Id="rule.display"]')).toBeNull();
		expect(merged.querySelector('TabDisplayRule[TabCommand="Tab.One"]')).toBeNull();
	});

	it("refuses to delete definitions or localized labels that surviving XML still references", () => {
		expect(() => mergeRibbonDiffXml(source, [delta(undefined, { removedCommandIds: ["cmd.A"] })])).toThrow(/referenc/i);
		expect(() => mergeRibbonDiffXml(source.replace('LabelText="A"', 'LabelText="$LocLabels:label.A"'), [delta(undefined, { removedLocLabelIds: ["label.A"] })])).toThrow(/referenc/i);
	});

	it("rejects duplicate declaration IDs across deltas and ambiguous originals", () => {
		const d = delta('<RibbonDiffXml><CommandDefinitions><CommandDefinition Id="cmd.D"/></CommandDefinitions></RibbonDiffXml>');
		expect(() => mergeRibbonDiffXml(source, [d, d])).toThrow(/duplicate/i);
		expect(() => mergeRibbonDiffXml(source.replace('</CommandDefinitions>', '<CommandDefinition Id="cmd.A"/></CommandDefinitions>'), [d])).toThrow(/duplicate/i);
	});

	it("rejects moving a control out of an embedded menu when its intended parent cannot be inferred", () => {
		const update = delta('<RibbonDiffXml><CustomActions><CustomAction Id="B.Move" Location="Another.Controls._children"><CommandUIDefinition><Button Id="B"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>');
		expect(() => mergeRibbonDiffXml(source, [update])).toThrow(/nested|move|location/i);
	});

	it("patches a uniquely owned tab and nested group without overwriting their siblings, extensions, or original action ID", () => {
		const original = '<RibbonDiffXml><CustomActions><CustomAction Id="odd.Action" Location="Mscrm.Tabs._children" Sequence="20"><CommandUIDefinition><Tab Id="Tab.A" Title="Old" Sequence="20" VendorTag="keep"><Groups><Group Id="Group.A" Title="Group Old" Sequence="10" Template="old" VendorGroup="keep"><Controls><Button Id="UnderGroup"/></Controls></Group><Group Id="Group.B" Title="Unaffected"/></Groups></Tab></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>';
		const patch = delta('<RibbonDiffXml/>', {
			elementPatches: [
				{ kind: "Tab", id: "Tab.A", attributes: { Title: "$LocLabels:Tab.A.Title", Sequence: "50" } },
				{ kind: "Group", id: "Group.A", attributes: { Title: "$LocLabels:Group.A.Title", Sequence: "15", Template: null } },
			]
		});
		const merged = parse(mergeRibbonDiffXml(original, [patch]));
		expect(merged.querySelector('CustomAction[Id="odd.Action"]')?.getAttribute("Sequence")).toBe("50");
		expect(merged.querySelector('Tab[Id="Tab.A"]')?.getAttribute("Title")).toBe("$LocLabels:Tab.A.Title");
		expect(merged.querySelector('Tab[Id="Tab.A"]')?.getAttribute("VendorTag")).toBe("keep");
		expect(merged.querySelector('Group[Id="Group.A"]')?.getAttribute("Sequence")).toBe("15");
		expect(merged.querySelector('Group[Id="Group.A"]')?.hasAttribute("Template")).toBe(false);
		expect(merged.querySelector('Group[Id="Group.A"]')?.getAttribute("VendorGroup")).toBe("keep");
		expect(merged.querySelector('Group[Id="Group.A"] Button[Id="UnderGroup"]')).not.toBeNull();
		expect(merged.querySelector('Group[Id="Group.B"]')?.getAttribute("Title")).toBe("Unaffected");
	});

	it("updates the enclosing CustomAction sequence when the target group is its directly authored root", () => {
		const original = '<RibbonDiffXml><CustomActions><CustomAction Id="odd.GroupAction" Location="Tab.A.Groups._children" Sequence="20"><CommandUIDefinition><Group Id="Group.C" Title="Old" Sequence="20" Other="retained"><Controls><Button Id="Child"/></Controls></Group></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>';
		const merged = parse(mergeRibbonDiffXml(original, [delta(undefined, { elementPatches: [{ kind: "Group", id: "Group.C", attributes: { Sequence: "70", Title: "Updated" } }] })]));
		expect(merged.querySelector('CustomAction[Id="odd.GroupAction"]')?.getAttribute("Sequence")).toBe("70");
		expect(merged.querySelector('Group[Id="Group.C"]')?.getAttribute("Other")).toBe("retained");
		expect(merged.querySelector('Group[Id="Group.C"] Button[Id="Child"]')).not.toBeNull();
	});

	it("rejects an unowned tab/group patch or ambiguous duplicate patch instead of targeting a guessed platform location", () => {
		const unowned = delta(undefined, { elementPatches: [{ kind: "Tab", id: "Mscrm.BuiltInTab", attributes: { Title: "No" } }] });
		expect(() => mergeRibbonDiffXml(source, [unowned])).toThrow(/unmanaged|not found|unique|owned/i);
		const duplicated = delta(undefined, { elementPatches: [{ kind: "Group", id: "G", attributes: { Title: "A" } }, { kind: "Group", id: "G", attributes: { Title: "B" } }] });
		expect(() => mergeRibbonDiffXml(source, [duplicated])).toThrow(/duplicate|ambiguous/i);
	});

	it("refuses an element patch that would change identity or uses an invalid Sequence", () => {
		const original = '<RibbonDiffXml><CustomActions><CustomAction Id="odd.GroupAction" Location="Tab.A.Groups._children"><CommandUIDefinition><Group Id="Group.C"/></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>';
		const identity = delta(undefined, { elementPatches: [{ kind: "Group", id: "Group.C", attributes: { Id: "Hijacked" } }] });
		expect(() => mergeRibbonDiffXml(original, [identity])).toThrow(/Id|attribute|identity/i);
		const badOrder = delta(undefined, { elementPatches: [{ kind: "Group", id: "Group.C", attributes: { Sequence: "NaN" } }] });
		expect(() => mergeRibbonDiffXml(original, [badOrder])).toThrow(/Sequence/i);
	});

	it("rejects malformed, DOCTYPE and unsupported incoming declaration nodes", () => {
		expect(() => mergeRibbonDiffXml("<RibbonDiffXml>", [])).toThrow(/xml|parse/i);
		expect(() => mergeRibbonDiffXml(source, [delta('<!DOCTYPE RibbonDiffXml><RibbonDiffXml/>')])).toThrow(/doctype/i);
		expect(() => mergeRibbonDiffXml(source, [delta('<RibbonDiffXml><CustomActions><UnsupportedAction Id="X"/></CustomActions></RibbonDiffXml>')])).toThrow(/unsupported/i);
	});
});

describe("canonicalizeXml", () => {
	it("ignores indentation and attribute order but keeps meaningful sibling order and text", () => {
		expect(canonicalizeXml('<Root z="2" a="1">\n <Child/>\n<Other> text </Other> </Root>'))
			.toBe(canonicalizeXml('<Root a="1" z="2"><Child></Child><Other> text </Other></Root>'));
		expect(canonicalizeXml('<Root><A/><B/></Root>')).not.toBe(canonicalizeXml('<Root><B/><A/></Root>'));
		expect(canonicalizeXml('<Root><T> x </T></Root>')).not.toBe(canonicalizeXml('<Root><T>x</T></Root>'));
	});

	it("rejects broken XML", () => {
		expect(() => canonicalizeXml('<Root><unclosed></Root>')).toThrow(/xml|parse/i);
	});
});
