import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import XmlDrawer from "@/components/panels/XmlDrawer";
import DiffViewer from "@/components/panels/DiffViewer";
import { useRibbonStore } from "@/store/ribbonStore";
import { useUIStore } from "@/store/uiStore";
import type { RibbonWorkspace, RibbonSourceSnapshot } from "@/types/workspace";

const editorActions = vi.hoisted(() => ({ format: vi.fn(), updateDiff: vi.fn(), copyFromHost: vi.fn() }));

vi.mock("@/services/dataverse/webResourceService", () => ({ loadWebResources: () => Promise.resolve([]) }));
vi.mock("@/utils/monacoCompletions", () => ({
	registerMonacoCompletions: vi.fn(() => [{ dispose: vi.fn() }]),
	disposeMonacoCompletions: vi.fn(),
}));
vi.mock("@/components/shared/MonacoEditor", () => ({
	default: ({ value, onMount }: { value: string; onMount?: (editor: unknown, monaco: unknown) => void }) => (
		<div>
			<output data-testid="xml-preview">{value}</output>
			{onMount && <button onClick={() => onMount({ getAction: () => ({ run: editorActions.format }) }, { languages: {} })} data-testid="mount-xml-editor">Mount XML editor</button>}
		</div>
	),
}));
vi.mock("@monaco-editor/react", () => ({
	DiffEditor: ({ original, modified, theme, onMount }: { original: string; modified: string; theme: string; onMount?: (editor: unknown) => void }) => (
		<div data-testid="diff-editor" data-theme={theme}>
			<output data-testid="original-xml">{original}</output><output data-testid="merged-xml">{modified}</output>
			<button onClick={() => onMount?.({ updateOptions: editorActions.updateDiff })} data-testid="mount-diff-editor">Mount diff editor</button>
		</div>
		),
}));

const originalEntity = '<RibbonDiffXml><CustomActions><CustomAction Id="Existing.A" Location="Group.Home.Controls._children"><CommandUIDefinition><Button Id="A" LabelText="A" Command="cmd.A"/></CommandUIDefinition></CustomAction></CustomActions><CommandDefinitions><CommandDefinition Id="cmd.A"><EnableRules/><DisplayRules/><Actions><Url Address="/a"/></Actions></CommandDefinition></CommandDefinitions><RuleDefinitions/><LocLabels/></RibbonDiffXml>';
const originalApplication = '<RibbonDiffXml><CustomActions><HideCustomAction HideActionId="App.Original.Hide" Location="App.Hidden"/></CustomActions></RibbonDiffXml>';

function renderPanel(panel: React.ReactElement) {
	return render(<FluentProvider theme={webLightTheme}>{panel}</FluentProvider>);
}

function seed(source: boolean) {
	const workspace: RibbonWorkspace = {
		ribbons: {
			HomepageGrid: { location: "HomepageGrid", entityLogicalName: "account", tabs: [{ id: "Tab.Home", label: "Home", sequence: 10, tabDisplayRules: [], groups: [{ id: "Group.Home", label: "Home", sequence: 10, template: "Flexible2", buttons: [{ id: "A", label: "A", commandId: "cmd.A", sequence: 10, kind: "button", templateAlias: "o1", hidden: false, oob: false, custom: true, managed: false }] }] }] },
			SubGrid: { location: "SubGrid", entityLogicalName: "account", tabs: [] },
			Form: { location: "Form", entityLogicalName: "account", tabs: [{ id: "Tab.Form", label: "Form", sequence: 10, tabDisplayRules: [], groups: [{ id: "Group.Form", label: "Form", sequence: 10, template: "Flexible2", buttons: [] }] }] },
			Application: { location: "Application", entityLogicalName: "{!EntityLogicalName}", tabs: [] },
		},
		commands: [{ id: "cmd.A", enableRules: [], displayRules: [], actions: [{ kind: "url", address: "/a", passParams: false, params: [] }] }],
		enableRules: [], displayRules: [], locLabels: [],
	};
	const snapshot: RibbonSourceSnapshot = {
		organizationUrl: "https://crm.example.test/Org", solutionUniqueName: "Test", entityLogicalName: "account", solutionVersion: "1.0.0.0",
		entityRibbonXml: originalEntity, applicationRibbonXml: originalApplication,
		solutionXml: "<ImportExportXml/>", customizationsXml: "<ImportExportXml/>", capturedAt: "2026-10-15T00:00:00Z",
	};
	act(() => useRibbonStore.getState().loadWorkspace({ ...workspace, sourceSnapshot: source ? snapshot : null }));
	if (source) act(() => useRibbonStore.getState().upsertCommand({ id: "cmd.A", enableRules: [], displayRules: [], actions: [{ kind: "url", address: "/edited", passParams: false, params: [] }] }));
}

	describe("upstream drawer layout with safe, source-aware XML and diff data", () => {
	let originalClipboard: PropertyDescriptor | undefined;
		beforeEach(() => {
			editorActions.format.mockClear();
			editorActions.updateDiff.mockClear();
		originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
		vi.stubGlobal("ResizeObserver", class {
			observe() { /* jsdom has no layout */ }
			unobserve() { /* jsdom has no layout */ }
			disconnect() { /* jsdom has no layout */ }
		});
		seed(true);
		act(() => useUIStore.setState({ xmlDrawerOpen: true, diffViewerOpen: true, diffViewerMode: "compare" }));
	});
	afterEach(async () => {
		// The app closes drawers while FluentProvider is still mounted. Let the
		// exit motion and Tabster/Keyborg registrations settle before removing
		// their provider, mocked globals, or the Zustand test workspace.
		await act(async () => {
			useUIStore.setState({ xmlDrawerOpen: false, diffViewerOpen: false });
		});
		await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
		await act(async () => {
			cleanup();
			await Promise.resolve();
		});
		if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
		else Reflect.deleteProperty(navigator, "clipboard");
		Reflect.deleteProperty(window, "toolboxAPI");
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		act(() => useRibbonStore.getState().clearWorkspace());
	});

		it("XmlDrawer preserves the upstream four location tabs and full Copy/Download/Format/Import toolbar", async () => {
			renderPanel(<XmlDrawer />);
		expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("value"))).toEqual(["HomepageGrid", "SubGrid", "Form", "Application"]);
			for (const action of [/^Copy$/i, /^Download$/i, /Format XML/i, /Import this XML/i]) {
				expect(screen.getByRole("button", { name: action })).toBeTruthy();
			}
			expect(screen.getByText(/complete.*unmanaged.*entity|entity.*complete.*unmanaged/i)).toBeTruthy();
			const xml = screen.getByTestId("xml-preview").textContent ?? "";
			expect(xml).toContain('Id="Existing.A"');
			expect(xml).toContain('Address="/edited"');
			fireEvent.click(screen.getByRole("tab", { name: /^Form$/i }));
			expect(screen.getByTestId("xml-preview").textContent).toContain("Existing.A");
			fireEvent.click(screen.getByRole("tab", { name: /^Sub Grid$/i }));
			expect(screen.getByTestId("xml-preview").textContent).toContain("Existing.A");
			fireEvent.click(screen.getByRole("tab", { name: /application/i }));
			expect(screen.getByTestId("xml-preview").textContent).toContain("App.Original.Hide");
			expect(screen.getByTestId("xml-preview").textContent).not.toContain("Existing.A");
			fireEvent.click(screen.getByRole("button", { name: /import this xml/i }));
			expect(useUIStore.getState().importXmlOpen).toBe(true);
		});

		it("XmlDrawer keeps Monaco inspection and safe delta copy available without source; warns it cannot publish", () => {
			seed(false);
			renderPanel(<XmlDrawer />);
		expect(screen.getAllByText(/source.*unavailable|export.*source|source.*required/i).length).toBeGreaterThan(0);
			expect(screen.getAllByText(/cannot publish|not publishable|requires.*source/i).length).toBeGreaterThan(0);
			expect(screen.getByRole("button", { name: /^Copy$/i })).not.toBeDisabled();
			expect(screen.getByRole("button", { name: /^Download$/i })).not.toBeDisabled();
			expect(screen.getByTestId("xml-preview").textContent).toContain("RibbonDiffXml");
			expect(screen.getAllByRole("tab")).toHaveLength(4);
		});

		it("XmlDrawer keeps upstream Monaco format command and completion registration on mount", async () => {
			const { registerMonacoCompletions } = await import("@/utils/monacoCompletions");
			renderPanel(<XmlDrawer />);
			fireEvent.click(screen.getByTestId("mount-xml-editor"));
			expect(registerMonacoCompletions).toHaveBeenCalled();
			fireEvent.click(screen.getByRole("button", { name: /Format XML/i }));
			await waitFor(() => expect(editorActions.format).toHaveBeenCalledTimes(1));
		});

		it("XmlDrawer restores the upstream Download action without publishing or changing workspace state", async () => {
			const createObjectURL = vi.fn(() => "blob:preview-test");
			const revokeObjectURL = vi.fn();
			Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
			Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
			const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
			renderPanel(<XmlDrawer />);
			const before = useRibbonStore.getState();
			fireEvent.click(screen.getByRole("button", { name: /^Download$/i }));
			expect(createObjectURL).toHaveBeenCalledTimes(1);
			expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-test");
			expect(click).toHaveBeenCalledTimes(1);
			expect(useRibbonStore.getState()).toEqual(before);
		});

		it("XmlDrawer preserves the editor and error notice when exported source XML is malformed", () => {
			const snapshot = useRibbonStore.getState().sourceSnapshot!;
			act(() => useRibbonStore.setState({ sourceSnapshot: { ...snapshot, entityRibbonXml: "<RibbonDiffXml>" } }));
			renderPanel(<XmlDrawer />);
			expect(screen.getAllByText(/cannot publish|source.*unavailable|matching exported solution/i).length).toBeGreaterThan(0);
			expect(screen.getByTestId("xml-preview").textContent).toContain("RibbonDiffXml");
			expect(screen.getAllByRole("tab")).toHaveLength(4);
		});

	it("XmlDrawer copies through toolbox utilities and catches clipboard failure without false success", async () => {
		const copyToClipboard = vi.fn().mockRejectedValue(new Error("Clipboard denied"));
		vi.stubGlobal("toolboxAPI", { utils: { copyToClipboard } });
		Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) }, configurable: true });
		renderPanel(<XmlDrawer />);
		fireEvent.click(screen.getByRole("button", { name: /copy/i }));
		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledTimes(1));
		await screen.findByText(/could not copy|clipboard.*failed|copy failed/i);
	});

	it("XmlDrawer falls back to the browser clipboard when the host utility rejects", async () => {
		const copyToClipboard = vi.fn().mockRejectedValue(new Error("Host clipboard unavailable"));
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("toolboxAPI", { utils: { copyToClipboard } });
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		renderPanel(<XmlDrawer />);
		fireEvent.click(screen.getByRole("button", { name: /copy/i }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Address="/edited"')));
		expect(screen.queryByText(/could not copy/i)).toBeNull();
	});

		it("DiffViewer restores full OverlayDrawer comparing original and merged entity plus application with stats and modes", async () => {
			renderPanel(<DiffViewer />);
			const original = await screen.findByTestId("original-xml");
			const modified = screen.getByTestId("merged-xml");
			expect(original.textContent).toContain(originalEntity);
			expect(original.textContent).toContain(originalApplication);
			expect(modified.textContent).toContain('Id="Existing.A"');
			expect(modified.textContent).toContain('Address="/edited"');
			expect(original.textContent).not.toContain("/edited");
			expect(screen.getByText(/Compare to baseline/i)).toBeTruthy();
			expect(screen.getByText(/\+\d+ lines/i)).toBeTruthy();
			expect(screen.getByText(/-\d+ lines/i)).toBeTruthy();
			fireEvent.click(screen.getByTestId("mount-diff-editor"));
			fireEvent.click(screen.getByRole("button", { name: /Unified/i }));
			expect(editorActions.updateDiff).toHaveBeenCalledWith({ renderSideBySide: false });
			fireEvent.click(screen.getByRole("button", { name: /Side by side/i }));
			expect(editorActions.updateDiff).toHaveBeenCalledWith({ renderSideBySide: true });
		});

		it("DiffViewer preserves Monaco dark theme in the original full-screen comparison", async () => {
			act(() => useUIStore.setState({ themeMode: "dark" }));
			renderPanel(<DiffViewer />);
			expect(await screen.findByTestId("diff-editor")).toHaveAttribute("data-theme", "vs-dark");
			expect(screen.getByRole("button", { name: /Unified/i })).toBeTruthy();
		});

		it("DiffViewer remains open with an explicitly partial delta comparison when source is missing", async () => {
			seed(false);
			renderPanel(<DiffViewer />);
			expect(screen.getAllByText(/source.*unavailable|export.*source|source.*required/i).length).toBeGreaterThan(0);
			expect(screen.getAllByText(/cannot publish|not publishable|requires.*source/i).length).toBeGreaterThan(0);
			expect(await screen.findByTestId("diff-editor")).toBeTruthy();
			expect(screen.getByTestId("merged-xml").textContent).toContain("RibbonDiffXml");
		});
});
