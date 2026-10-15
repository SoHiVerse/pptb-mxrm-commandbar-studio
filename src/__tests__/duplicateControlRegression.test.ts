import { describe, expect, it } from "vitest";
import { generateRibbonDelta, summarizeRibbonDiff } from "@/services/xmlGenerator";
import type { CommandDefinition, RibbonButton, RibbonDefinition, RibbonTab } from "@/types/ribbon";
import type { RibbonDefinitions } from "@/types/workspace";

// Sanitized analogue of a valid Dynamics 365 9.1 application ribbon:
// one platform control ID occurs beneath two unrelated groups with different
// sequences. Neither occurrence may be redefined merely because another
// control/command in the solution changes.
const REUSED = "MailApp.ViewEmailActivity.Button";
const GLOBAL = "Mscrm.GlobalTab.New";
const QUICK = "Mscrm.QuickForm.{!EntityLogicalName}.MainTab.Actions";
const OTHER = "publisher.Application.UnrelatedButton";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const button = (id: string, sequence: number, commandId = "Mscrm.ViewEmailActivity"): RibbonButton => ({
	id, label: id === REUSED ? "View email" : "Unrelated application action", kind: "button",
	sequence, templateAlias: "o1", commandId, hidden: false, oob: id === REUSED,
	custom: id !== REUSED, managed: false,
});

function appFixture(): { baseline: RibbonDefinition; current: RibbonDefinition; definitions: RibbonDefinitions; baselineDefinitions: RibbonDefinitions } {
	const tabs: RibbonTab[] = [
		{
			id: "Mscrm.GlobalTab", label: "Global", sequence: 10, tabDisplayRules: [],
			groups: [{ id: GLOBAL, label: "New", sequence: 10, template: "Mscrm.Templates.Flexible2", buttons: [button(REUSED, 5)] }],
		},
		{
			id: "Mscrm.QuickForm.{!EntityLogicalName}.MainTab", label: "Quick form", sequence: 20, tabDisplayRules: [],
			groups: [{ id: QUICK, label: "Actions", sequence: 10, template: "Mscrm.Templates.Flexible2",
				buttons: [button(REUSED, 8), button(OTHER, 20, "publisher.UnrelatedCommand")] }],
		},
	];
	const baseline: RibbonDefinition = { location: "Application", entityLogicalName: "{!EntityLogicalName}", tabs };
	const system: CommandDefinition = {
		id: "Mscrm.ViewEmailActivity", actions: [{ kind: "url", address: "https://example.invalid/email", passParams: false, params: [] }],
		enableRules: [], displayRules: [], sourceXml: '<CommandDefinition Id="Mscrm.ViewEmailActivity"><Actions><Url Address="https://example.invalid/email"/></Actions></CommandDefinition>',
	};
	const own: CommandDefinition = {
		id: "publisher.UnrelatedCommand", actions: [{ kind: "javascript", library: "$webresource:publisher_/app.js", functionName: "publisher.Open", params: [] }],
		enableRules: [], displayRules: [],
	};
	const definitions: RibbonDefinitions = { commands: [system, own], enableRules: [], displayRules: [], locLabels: [] };
	return { baseline, current: clone(baseline), definitions, baselineDefinitions: clone(definitions) };
}

function input(fixture: ReturnType<typeof appFixture>) {
	return {
		current: fixture.current, baseline: fixture.baseline, ...fixture.definitions,
		baselineDefinitions: fixture.baselineDefinitions, location: "Application" as const,
		entityLogicalName: "{!EntityLogicalName}",
	};
}

function emittedControlIds(xml: string): string[] {
	const doc = new DOMParser().parseFromString(xml, "application/xml");
	expect(doc.querySelector("parsererror")).toBeNull();
	return [...doc.querySelectorAll("CustomActions > CustomAction > CommandUIDefinition > [Id]")].map(element => element.getAttribute("Id")!);
}

function assertOnlyOriginalDuplicates(fixture: ReturnType<typeof appFixture>): void {
	const occurrences = fixture.current.tabs.flatMap(tab => tab.groups.flatMap(group => group.buttons.filter(b => b.id === REUSED)));
	expect(occurrences.map(button => button.sequence)).toEqual([5, 8]);
}

describe("platform control ID reused in multiple application ribbon groups", () => {
	it("keeps an unchanged duplicate-ID application ribbon completely unmodified, even with unrelated entity definitions", () => {
		const fixture = appFixture();
		const unrelated: CommandDefinition = { id: "publisher.account.EntityOnlyCommand", enableRules: [], displayRules: [],
			actions: [{ kind: "url", address: "https://example.invalid/entity", passParams: false, params: [] }] };
		fixture.definitions.commands.push(unrelated);
		fixture.baselineDefinitions.commands.push(clone(unrelated));
		assertOnlyOriginalDuplicates(fixture);
		expect(summarizeRibbonDiff(fixture.current, fixture.baseline, fixture.definitions, fixture.baselineDefinitions).hasAnyChange).toBe(false);
		const delta = generateRibbonDelta(input(fixture));
		expect(emittedControlIds(delta.xml)).toEqual([]);
		const doc = new DOMParser().parseFromString(delta.xml, "application/xml");
		expect(doc.querySelector("CommandDefinitions > CommandDefinition, RuleDefinitions > EnableRules > EnableRule, LocLabels > LocLabel")).toBeNull();
		expect(delta.elementPatches).toEqual([]);
		expect(delta.removedControlIds).toEqual([]);
		expect(delta.unhiddenControlIds).toEqual([]);
	});

	it("permits an unrelated application button's edit without re-emitting either platform occurrence", () => {
		const fixture = appFixture();
		fixture.current.tabs[1].groups[0].buttons[1].label = "Edited unrelated action";
		const summary = summarizeRibbonDiff(fixture.current, fixture.baseline, fixture.definitions, fixture.baselineDefinitions);
		expect(summary.hasAnyChange).toBe(true);
		expect(summary.overriddenButtons).toBe(1);
		const delta = generateRibbonDelta(input(fixture));
		expect(emittedControlIds(delta.xml)).toEqual([OTHER]);
		expect(delta.xml).toContain("Edited unrelated action");
		expect(delta.removedControlIds).toEqual([]);
		assertOnlyOriginalDuplicates(fixture);
	});

	it("permits creating a separate application button without rewriting unrelated reused platform controls", () => {
		const fixture = appFixture();
		fixture.current.tabs[1].groups[0].buttons.push(button("publisher.Application.NewButton", 30, "publisher.UnrelatedCommand"));
		const delta = generateRibbonDelta(input(fixture));
		expect(emittedControlIds(delta.xml)).toEqual(["publisher.Application.NewButton"]);
		expect(delta.removedControlIds).toEqual([]);
		assertOnlyOriginalDuplicates(fixture);
	});

	it("emits only a narrow Tab/Group title patch around untouched duplicate control IDs", () => {
		const fixture = appFixture();
		fixture.current.tabs[0].label = "Retitled global tab";
		fixture.current.tabs[1].groups[0].label = "Retitled quick form actions";
		const delta = generateRibbonDelta(input(fixture));
		expect(emittedControlIds(delta.xml)).toEqual([]);
		expect(delta.elementPatches).toEqual([
			{ kind: "Tab", id: "Mscrm.GlobalTab", attributes: { Title: "$LocLabels:Mscrm.GlobalTab.Title" } },
			{ kind: "Group", id: QUICK, attributes: { Title: `$LocLabels:${QUICK}.Title` } },
		]);
		expect(delta.xml).toContain("Retitled global tab");
		expect(delta.xml).toContain("Retitled quick form actions");
	});

	it("allows raw-only cache rebasing of reused controls and multiple same-ID ordinal occurrences within one group", () => {
		const fixture = appFixture();
		const second = clone(fixture.baseline.tabs[0].groups[0].buttons[0]);
		second.sequence = 7;
		fixture.baseline.tabs[0].groups[0].buttons.push(second);
		fixture.current = clone(fixture.baseline);
		fixture.current.tabs[0].groups[0].buttons[0].sourceXml = '<Button Id="MailApp.ViewEmailActivity.Button" NewlyVerified="true"/>';
		expect(summarizeRibbonDiff(fixture.current, fixture.baseline).hasAnyChange).toBe(false);
		expect(emittedControlIds(generateRibbonDelta(input(fixture)).xml)).toEqual([]);
	});

	it("rejects implicit sequence normalization that would rewrite reused controls", () => {
		const fixture = appFixture();
		fixture.current.tabs[1].groups[0].buttons.splice(1, 0, button("publisher.CollidingNew", 8, "publisher.UnrelatedCommand"));
		expect(() => generateRibbonDelta(input(fixture))).toThrow(/duplicate|ambiguous|reused/i);
	});

	it("keeps both occurrences as command references when their shared command is intentionally edited", () => {
		const fixture = appFixture();
		const command = fixture.definitions.commands.find(command => command.id === "Mscrm.ViewEmailActivity")!;
		command.actions = [{ kind: "url", address: "https://example.invalid/explicit-override", passParams: false, params: [] }];
		const delta = generateRibbonDelta(input(fixture));
		expect(emittedControlIds(delta.xml)).toEqual([]);
		expect(delta.xml).toContain("explicit-override");
		expect(summarizeRibbonDiff(fixture.current, fixture.baseline, fixture.definitions, fixture.baselineDefinitions).changedDefinitions).toBe(1);
	});

	it.each(["label", "command", "sequence", "hide"] as const)(
		"rejects the ambiguous %s edit of only one duplicate occurrence before serializing",
		(kind) => {
			const fixture = appFixture();
			const target = fixture.current.tabs[1].groups[0].buttons[0];
			if (kind === "label") target.label = "Wrong edit";
			else if (kind === "command") target.commandId = "publisher.UnrelatedCommand";
			else if (kind === "sequence") target.sequence = 32;
			else target.hidden = true;
			expect(() => generateRibbonDelta(input(fixture))).toThrow(/duplicate|ambiguous|reused/i);
			expect(() => summarizeRibbonDiff(fixture.current, fixture.baseline)).toThrow(/duplicate|ambiguous|reused/i);
		},
	);

	it("rejects deletion of only one duplicate occurrence", () => {
		const fixture = appFixture();
		fixture.current.tabs[1].groups[0].buttons.shift();
		expect(() => generateRibbonDelta(input(fixture))).toThrow(/duplicate|ambiguous|reused/i);
	});

	it("rejects relocation of a duplicate occurrence into another parent group", () => {
		const fixture = appFixture();
		const removed = fixture.current.tabs[1].groups[0].buttons.shift()!;
		fixture.current.tabs[0].groups[0].buttons.push(removed);
		expect(() => generateRibbonDelta(input(fixture))).toThrow(/duplicate|ambiguous|reused/i);
	});

	it("rejects ambiguous sequence reordering involving a duplicated control and an ordinary sibling", () => {
		const fixture = appFixture();
		fixture.current.tabs[1].groups[0].buttons.reverse();
		expect(() => generateRibbonDelta(input(fixture))).toThrow(/duplicate|ambiguous|reused/i);
	});

	it("rejects newly introduced duplicate IDs even when both authored controls are identical", () => {
		const fixture = appFixture();
		fixture.current.tabs[0].groups[0].buttons.push(button("publisher.NewDuplicate", 30, "publisher.UnrelatedCommand"));
		fixture.current.tabs[1].groups[0].buttons.push(button("publisher.NewDuplicate", 30, "publisher.UnrelatedCommand"));
		expect(() => generateRibbonDelta(input(fixture))).toThrow(/duplicate|ambiguous|reused/i);
	});
});
