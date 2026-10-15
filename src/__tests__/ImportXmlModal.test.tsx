import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportXmlModal } from "@/components/modals/ImportXmlModal";
import { useRibbonStore, getBaselineWorkspace, getEditableWorkspace } from "@/store/ribbonStore";
import { useSessionStore } from "@/store/sessionStore";
import { useSelectionStore } from "@/store/selectionStore";
import { useUIStore } from "@/store/uiStore";
import type { RibbonWorkspace, RibbonSourceSnapshot } from "@/types/workspace";

vi.mock("@/components/shared/MonacoEditor", () => ({
	default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) =>
		<textarea aria-label="Ribbon XML" value={value} onChange={event => onChange(event.currentTarget.value)} />,
}));

// The modal's import behavior is independent from Fluent's animation/focus
// portals; rendering those in jsdom emits Keyborg teardown noise and obscures
// store assertions. Keep the real tabs, MessageBars and buttons.
vi.mock("@fluentui/react-components", async (importOriginal) => {
	const original = await importOriginal<typeof import("@fluentui/react-components")>();
	return {
		...original,
		Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null,
		DialogSurface: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	};
});

beforeAll(() => {
	class ResizeObserverStub {
		observe() { /* no layout in jsdom */ }
		unobserve() { /* no layout in jsdom */ }
		disconnect() { /* no layout in jsdom */ }
	}
	vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

const source: RibbonSourceSnapshot = {
	organizationUrl: "https://crm.example.test/Org", solutionUniqueName: "RibbonSolution", entityLogicalName: "account",
	solutionVersion: "1.0.0.0", solutionXml: "<ImportExportXml/>", customizationsXml: "<ImportExportXml/>",
	entityRibbonXml: "<RibbonDiffXml/>", applicationRibbonXml: null, capturedAt: "2026-10-15T02:00:00Z",
};

function seed(): RibbonWorkspace {
	const buttons = [{ id: "Before", label: "Before", commandId: "Original.Command", sequence: 10, templateAlias: "o1", kind: "button" as const, oob: false, custom: true, managed: false, hidden: false }];
	return {
		ribbons: {
			HomepageGrid: { location: "HomepageGrid", entityLogicalName: "account", tabs: [{ id: "Tab.Home", label: "Home", sequence: 10, tabDisplayRules: [], groups: [{ id: "Group.Home", label: "Home group", sequence: 10, template: "Mscrm.Templates.Flexible2", buttons }] }] },
			SubGrid: { location: "SubGrid", entityLogicalName: "account", tabs: [] },
			Form: { location: "Form", entityLogicalName: "account", tabs: [] },
			Application: { location: "Application", entityLogicalName: "{!EntityLogicalName}", tabs: [] },
		},
		commands: [{ id: "Original.Command", enableRules: [], displayRules: [], actions: [{ kind: "url", address: "/original", passParams: false, params: [] }] }],
		enableRules: [], displayRules: [], locLabels: [],
	};
}

const xml = '<RibbonDiffXml><CustomActions><CustomAction Id="New.CustomAction" Location="Group.Home.Controls._children" Sequence="50"><CommandUIDefinition><Button Id="New" LabelText="Imported" Command="New.Command" Sequence="50"/></CommandUIDefinition></CustomAction></CustomActions><CommandDefinitions><CommandDefinition Id="New.Command"><Actions><JavaScriptFunction FunctionName="run" Library="$webresource:sample.js"/></Actions></CommandDefinition></CommandDefinitions></RibbonDiffXml>';

function setup(withSource = true) {
	act(() => {
		useRibbonStore.getState().loadWorkspace({ ...seed(), sourceSnapshot: withSource ? source : null });
		useSessionStore.setState({
			activeEntity: { metadataId: "record-id", logicalName: "account", displayName: "Account", isCustomEntity: false, isManaged: false, isIntersect: false },
			activeSolution: { id: "id", uniqueName: "RibbonSolution", friendlyName: "RibbonSolution", version: "1.0.0.0", isManaged: false, publisherId: "id", publisherUniqueName: "Publisher", publisherName: "Publisher", publisherPrefix: "cust" },
			connectionUrl: "https://crm.example.test/Org",
		});
		useSelectionStore.setState({ location: "HomepageGrid" });
		useUIStore.setState({ importXmlOpen: true });
	});
	return render(<ImportXmlModal />);
}

function enter(xmlText: string) {
	fireEvent.change(screen.getByRole("textbox", { name: "Ribbon XML" }), { target: { value: xmlText } });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
	act(() => useUIStore.setState({ importXmlOpen: false }));
	vi.restoreAllMocks();
});

describe("ImportXmlModal safe workspace import", () => {
	it("preserves the upstream dialog tabs, editable Monaco surface, and Validate/Import/Cancel actions", () => {
		setup();
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(screen.getByText("Import RibbonDiffXml")).toBeTruthy();
		expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("value"))).toEqual(["replace", "append"]);
		expect(screen.getByRole("tab", { name: "Replace current" })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "Merge / append" })).toBeTruthy();
		expect(screen.getByRole("textbox", { name: "Ribbon XML" })).not.toHaveAttribute("readonly");
		for (const text of ["Cancel", "Validate", "Import"]) {
			expect(screen.getByRole("button", { name: text })).toBeTruthy();
		}
		expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
	});

	it("keeps the original dialog editor inspectable and permits local-only import without exported source", async () => {
		setup(false);
		const initial = useRibbonStore.getState();
		enter(xml);
		expect(screen.getByRole("textbox", { name: "Ribbon XML" })).toHaveValue(xml);
		expect(screen.getByRole("button", { name: "Validate" })).not.toBeDisabled();
		expect(screen.getByRole("button", { name: "Import" })).not.toBeDisabled();
		expect(screen.getByText(/cannot publish until.*source.*exported/i)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Validate" }));
		expect(await screen.findByText(/XML is valid/i)).toBeInTheDocument();
		expect(useRibbonStore.getState().past).toHaveLength(0); // Validate is read-only
		fireEvent.click(screen.getByRole("button", { name: "Import" }));
		await waitFor(() => expect(useUIStore.getState().importXmlOpen).toBe(false));
		const state = useRibbonStore.getState();
		expect(state.past).toHaveLength(1);
		expect(state.sourceSnapshot).toBeNull();
		expect(state.baseline).toEqual(initial.baseline);
		expect(state.commands.some(command => command.id === "New.Command")).toBe(true);
	});

	it("validates supported XML and commits one undoable edit without clearing baseline or source", async () => {
		setup();
		const original = useRibbonStore.getState();
		expect(screen.queryByText(/XML is valid/i)).not.toBeInTheDocument();
		enter(xml);
		expect(screen.queryByText(/XML is valid/i)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Validate" }));
		expect(await screen.findByText(/XML is valid/i)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Import" }));
		await waitFor(() => expect(useUIStore.getState().importXmlOpen).toBe(false));
		const state = useRibbonStore.getState();
		expect(state.ribbons.HomepageGrid.tabs[0].groups[0].buttons.some(button => button.id === "New")).toBe(true);
		expect(state.commands.find(command => command.id === "New.Command")?.actions[0]).toMatchObject({ kind: "javascript", functionName: "run" });
		expect(state.baseline).toEqual(original.baseline);
		expect(state.baselineDefinitions).toEqual(original.baselineDefinitions);
		expect(state.sourceSnapshot).toEqual(source);
		expect(state.past).toHaveLength(1);
		expect(state.past[0].detail).toBe("Imported ribbon XML");
		expect(state.mutationsSincePublish).toBeGreaterThan(0);
		act(() => state.undo());
		expect(useRibbonStore.getState().ribbons.HomepageGrid.tabs[0].groups[0].buttons.some(button => button.id === "New")).toBe(false);
	});

	it("warns that Replace discards all unsaved editor edits and restores the loaded baseline", async () => {
		setup();
		act(() => useRibbonStore.getState().upsertLocLabel({ id: "Unsaved", titles: [{ languageCode: 1033, description: "unsaved" }] }));
		enter(xml);
		fireEvent.click(screen.getByRole("tab", { name: /Replace/i }));
		expect(screen.getByText(/discard all unsaved workspace edits/i)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Import" }));
		await waitFor(() => expect(useUIStore.getState().importXmlOpen).toBe(false));
		const state = useRibbonStore.getState();
		expect(state.locLabels.find(label => label.id === "Unsaved")).toBeUndefined();
		expect(state.sourceSnapshot).toEqual(source);
		expect(getBaselineWorkspace(state).locLabels).toHaveLength(0);
		expect(getEditableWorkspace(state).ribbons.HomepageGrid.tabs[0].groups[0].buttons.some(button => button.id === "New")).toBe(true);
		expect(state.past).toHaveLength(2);
	});

	it("shows import validation errors and never mutates any store state for invalid XML", async () => {
		setup();
		const before = useRibbonStore.getState();
		enter('<RibbonDiffXml><CommandDefinitions><CommandDefinition Id="Unsafe"><Actions><PowerFxAction/></Actions></CommandDefinition></CommandDefinitions></RibbonDiffXml>');
		fireEvent.click(screen.getByRole("button", { name: "Import" }));
		expect(await screen.findByText(/Unsupported.*PowerFxAction/i)).toBeInTheDocument();
		expect(useUIStore.getState().importXmlOpen).toBe(true);
		expect(useRibbonStore.getState()).toEqual(before);
		expect(screen.queryByText(/XML is valid/i)).not.toBeInTheDocument();
	});

	it("allows source-less local editor changes but blocks import after a mismatched active entity is selected", async () => {
		setup(false);
		enter(xml);
		expect(screen.getByRole("button", { name: "Import" })).not.toBeDisabled();
		act(() => {
			useRibbonStore.getState().loadWorkspace({ ...seed(), sourceSnapshot: source });
			useSessionStore.setState({ activeEntity: { metadataId: "other", logicalName: "contact", displayName: "Contact", isCustomEntity: false, isManaged: false, isIntersect: false } });
		});
		expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Validate" }));
		await waitFor(() => expect(screen.getAllByText(/selected entity does not match/i).length).toBeGreaterThan(0));
		expect(useRibbonStore.getState().past).toHaveLength(0);
	});

	it("clears its validated label when the XML changes", async () => {
		setup();
		enter(xml);
		fireEvent.click(screen.getByRole("button", { name: "Validate" }));
		expect(await screen.findByText(/XML is valid/i)).toBeInTheDocument();
		enter('<RibbonDiffXml/>');
		expect(screen.queryByText(/XML is valid/i)).not.toBeInTheDocument();
	});
});
