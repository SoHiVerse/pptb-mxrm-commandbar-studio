import { describe, it, expect, beforeEach } from "vitest";
import { useRibbonStore } from "@/store/ribbonStore";
import type { RibbonDefinition } from "@/types/ribbon";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTestRibbon(): RibbonDefinition {
	return {
		location: "HomepageGrid",
		entityLogicalName: "account",
		tabs: [
			{
				id: "Tab1",
				label: "Main Tab",
				sequence: 10,
				tabDisplayRules: [],
				groups: [
					{
						id: "Group1",
						label: "New",
						sequence: 10,
						template: "Mscrm.Templates.Flexible2",
						buttons: [
							{
								id: "Button1",
								label: "Button 1",
								kind: "button",
								sequence: 10,
								templateAlias: "o1",
								commandId: "Command1",
								hidden: false,
								oob: false,
								custom: true,
								managed: false,
							},
							{
								id: "Button2",
								label: "Button 2",
								kind: "button",
								sequence: 20,
								templateAlias: "o1",
								commandId: "Command2",
								hidden: false,
								oob: true,
								custom: false,
								managed: false,
							},
						],
					},
					{
						id: "Group2",
						label: "Actions",
						sequence: 20,
						template: "Mscrm.Templates.Flexible2",
						buttons: [],
					},
				],
			},
		],
	};
}

beforeEach(() => {
	// Reset store state before each test
	useRibbonStore.setState({
		// This fixture represents a loaded editable workspace, not a failed live source export.
		workspaceReadOnly: false,
		sourceSnapshot: null,
		workspaceGeneration: 1,
		baselineDefinitions: { commands: [], displayRules: [], enableRules: [], locLabels: [] },
		ribbons: {
			HomepageGrid: makeTestRibbon(),
			SubGrid: { location: "SubGrid", entityLogicalName: "account", tabs: [] },
			Form: { location: "Form", entityLogicalName: "account", tabs: [] },
			Application: { location: "Application", entityLogicalName: "", tabs: [] },
		},
		baseline: {
			HomepageGrid: makeTestRibbon(),
			SubGrid: { location: "SubGrid", entityLogicalName: "account", tabs: [] },
			Form: { location: "Form", entityLogicalName: "account", tabs: [] },
			Application: { location: "Application", entityLogicalName: "", tabs: [] },
		},
		commands: [],
		displayRules: [],
		enableRules: [],
		locLabels: [],
		templates: [],
		conflicts: [],
		mutationsSincePublish: 0,
		past: [],
		future: [],
	});
});

// ── moveButton ─────────────────────────────────────────────────────────────

describe("moveButton", () => {
	it("moves a button from one group to another", () => {
		const { moveButton } = useRibbonStore.getState();

		moveButton(
			{ location: "HomepageGrid", tabId: "Tab1", groupId: "Group1", buttonId: "Button1" },
			{ location: "HomepageGrid", tabId: "Tab1", groupId: "Group2" },
		);

		const state = useRibbonStore.getState();
		const group1 = state.ribbons.HomepageGrid.tabs[0].groups[0];
		const group2 = state.ribbons.HomepageGrid.tabs[0].groups[1];

		expect(group1.buttons.find((b) => b.id === "Button1")).toBeUndefined();
		expect(group2.buttons.find((b) => b.id === "Button1")).toBeDefined();
	});

	it("increments mutationsSincePublish after moveButton", () => {
		const { moveButton } = useRibbonStore.getState();
		const before = useRibbonStore.getState().mutationsSincePublish;

		moveButton(
			{ location: "HomepageGrid", tabId: "Tab1", groupId: "Group1", buttonId: "Button1" },
			{ location: "HomepageGrid", tabId: "Tab1", groupId: "Group2" },
		);

		expect(useRibbonStore.getState().mutationsSincePublish).toBe(before + 1);
	});
});

// ── hideOobButton ──────────────────────────────────────────────────────────

describe("hideOobButton", () => {
	it("sets hidden: true on an OOB button", () => {
		const { hideOobButton } = useRibbonStore.getState();

		hideOobButton("HomepageGrid", "Tab1", "Group1", "Button2");

		const state = useRibbonStore.getState();
		const btn = state.ribbons.HomepageGrid.tabs[0].groups[0].buttons.find(
			(b) => b.id === "Button2",
		);
		expect(btn?.hidden).toBe(true);
	});

	it("increments mutationsSincePublish when hiding an OOB button", () => {
		const { hideOobButton } = useRibbonStore.getState();
		const before = useRibbonStore.getState().mutationsSincePublish;

		hideOobButton("HomepageGrid", "Tab1", "Group1", "Button2");

		expect(useRibbonStore.getState().mutationsSincePublish).toBe(before + 1);
	});
});

// ── customizeOobButton ─────────────────────────────────────────────────────

describe("customizeOobButton", () => {
	it("creates a custom button scaffold from an OOB button", () => {
		const { customizeOobButton } = useRibbonStore.getState();

		customizeOobButton("HomepageGrid", "Tab1", "Group1", "Button2");

		const state = useRibbonStore.getState();
		const group = state.ribbons.HomepageGrid.tabs[0].groups[0];
		const customized = group.buttons.find((b) => b.id === "Button2");
		expect(customized?.custom).toBe(true);
	});
});

// ── mutationsSincePublish ──────────────────────────────────────────────────

describe("mutationsSincePublish", () => {
	it("starts at 0 after reset", () => {
		expect(useRibbonStore.getState().mutationsSincePublish).toBe(0);
	});

	it("increments on every commit (deleteButton)", () => {
		const { deleteButton } = useRibbonStore.getState();

		deleteButton("HomepageGrid", "Tab1", "Group1", "Button1");
		expect(useRibbonStore.getState().mutationsSincePublish).toBe(1);

		deleteButton("HomepageGrid", "Tab1", "Group1", "Button2");
		expect(useRibbonStore.getState().mutationsSincePublish).toBe(2);
	});

	it("resets to 0 after markPublished", () => {
		const { deleteButton, markPublished } = useRibbonStore.getState();

		deleteButton("HomepageGrid", "Tab1", "Group1", "Button1");
		expect(useRibbonStore.getState().mutationsSincePublish).toBe(1);

		markPublished();
		expect(useRibbonStore.getState().mutationsSincePublish).toBe(0);
	});
});

// ── Undo / Redo ────────────────────────────────────────────────────────────

describe("undo and redo", () => {
	it("undo restores the previous state", () => {
		const { deleteButton, undo } = useRibbonStore.getState();
		const buttonCountBefore =
			useRibbonStore.getState().ribbons.HomepageGrid.tabs[0].groups[0].buttons.length;

		deleteButton("HomepageGrid", "Tab1", "Group1", "Button1");
		expect(useRibbonStore.getState().ribbons.HomepageGrid.tabs[0].groups[0].buttons.length).toBe(
			buttonCountBefore - 1,
		);

		undo();
		expect(useRibbonStore.getState().ribbons.HomepageGrid.tabs[0].groups[0].buttons.length).toBe(
			buttonCountBefore,
		);
	});

	it("redo re-applies an undone mutation", () => {
		const { deleteButton, undo, redo } = useRibbonStore.getState();
		const buttonCountBefore =
			useRibbonStore.getState().ribbons.HomepageGrid.tabs[0].groups[0].buttons.length;

		deleteButton("HomepageGrid", "Tab1", "Group1", "Button1");
		undo();
		redo();

		expect(useRibbonStore.getState().ribbons.HomepageGrid.tabs[0].groups[0].buttons.length).toBe(
			buttonCountBefore - 1,
		);
	});

	it("undo does nothing when past stack is empty", () => {
		const { undo } = useRibbonStore.getState();
		const stateBefore = useRibbonStore.getState().ribbons;
		undo();
		expect(useRibbonStore.getState().ribbons).toEqual(stateBefore);
	});

	it("redo does nothing when future stack is empty", () => {
		const { redo } = useRibbonStore.getState();
		const stateBefore = useRibbonStore.getState().ribbons;
		redo();
		expect(useRibbonStore.getState().ribbons).toEqual(stateBefore);
	});
});

// ── History stack cap ──────────────────────────────────────────────────────

describe("history stack cap", () => {
	it("caps history at MAX_HISTORY (80) entries", () => {
		const { createTab } = useRibbonStore.getState();

		// Perform 90 mutations
		for (let i = 0; i < 90; i++) {
			createTab("HomepageGrid", { id: `Tab_${i}`, label: `Tab ${i}`, sequence: i + 100 });
		}

		const { past } = useRibbonStore.getState();
		expect(past.length).toBeLessThanOrEqual(80);
	});
});

// ── upsertCommand ──────────────────────────────────────────────────────────

describe("upsertCommand", () => {
	it("adds a new command", () => {
		const { upsertCommand } = useRibbonStore.getState();

		upsertCommand({
			id: "Contoso.account.Test.Command",
			enableRules: [],
			displayRules: [],
			actions: [],
		});

		const { commands } = useRibbonStore.getState();
		expect(commands.find((c) => c.id === "Contoso.account.Test.Command")).toBeDefined();
	});

	it("updates an existing command when ID matches", () => {
		const { upsertCommand } = useRibbonStore.getState();

		upsertCommand({ id: "Cmd1", enableRules: [], displayRules: [], actions: [] });
		upsertCommand({
			id: "Cmd1",
			enableRules: ["Rule1"],
			displayRules: [],
			actions: [],
		});

		const { commands } = useRibbonStore.getState();
		const cmd = commands.find((c) => c.id === "Cmd1");
		expect(cmd?.enableRules).toContain("Rule1");
		expect(commands.filter((c) => c.id === "Cmd1").length).toBe(1);
	});
});

// ── setButtonProp ──────────────────────────────────────────────────────────

describe("setButtonProp", () => {
	it("updates a specific property of a button", () => {
		const { setButtonProp } = useRibbonStore.getState();

		setButtonProp("HomepageGrid", "Tab1", "Group1", "Button1", { label: "Updated Label" });

		const state = useRibbonStore.getState();
		const btn = state.ribbons.HomepageGrid.tabs[0].groups[0].buttons.find(
			(b) => b.id === "Button1",
		);
		expect(btn?.label).toBe("Updated Label");
	});

	it("does not affect other buttons when updating one", () => {
		const { setButtonProp } = useRibbonStore.getState();

		setButtonProp("HomepageGrid", "Tab1", "Group1", "Button1", { label: "New Label" });

		const state = useRibbonStore.getState();
		const btn2 = state.ribbons.HomepageGrid.tabs[0].groups[0].buttons.find(
			(b) => b.id === "Button2",
		);
		expect(btn2?.label).toBe("Button 2");
	});
});
