import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BulkPublishModal } from "@/components/modals/BulkPublishModal";
import { useRibbonStore } from "@/store/ribbonStore";
import { useSessionStore } from "@/store/sessionStore";
import { useUIStore } from "@/store/uiStore";
import { activateOnPremRuntime, activatePptbRuntime } from "@/hosts/runtime";
import type { PreparedRibbonPublish, PublishedRibbonResult, RibbonPublishInput } from "@/services/dataverse/publishService";
import type { RibbonSourceSnapshot, RibbonWorkspace } from "@/types/workspace";

const services = vi.hoisted(() => ({ prepare: vi.fn(), publish: vi.fn() }));
vi.mock("@/services/dataverse/publishService", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/dataverse/publishService")>();
	return { ...actual, prepareRibbonPublish: services.prepare, publishRibbonWorkspace: services.publish };
});

const ORG = "https://crm.example.test/Org";
beforeAll(() => {
	// Fluent overlays observe layout; jsdom has no ResizeObserver implementation.
	class ResizeObserverStub {
		observe() { /* no layout engine */ }
		unobserve() { /* no layout engine */ }
		disconnect() { /* no layout engine */ }
	}
	vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});
afterAll(() => vi.unstubAllGlobals());
const source = (entity = "account", solution = "RibbonOne"): RibbonSourceSnapshot => ({
	organizationUrl: ORG,
	solutionUniqueName: solution,
	entityLogicalName: entity,
	solutionVersion: "1.0.0.0",
	solutionXml: "<ImportExportXml/>",
	customizationsXml: "<ImportExportXml/>",
	entityRibbonXml: "<RibbonDiffXml/>",
	applicationRibbonXml: "<RibbonDiffXml/>",
	capturedAt: "2026-10-15T00:00:00Z",
});

function workspace(entity = "account"): RibbonWorkspace {
	return {
		ribbons: {
			HomepageGrid: { location: "HomepageGrid", entityLogicalName: entity, tabs: [] },
			SubGrid: { location: "SubGrid", entityLogicalName: entity, tabs: [] },
			Form: { location: "Form", entityLogicalName: entity, tabs: [] },
			Application: { location: "Application", entityLogicalName: "{!EntityLogicalName}", tabs: [] },
		},
		commands: [], displayRules: [], enableRules: [], locLabels: [],
	};
}

function prepared(input: RibbonPublishInput): PreparedRibbonPublish {
	return {
		input, base64: "UEs=", backupBase64: "UEs=", entityRibbonXml: "<RibbonDiffXml/>",
		entityDeltas: [], applicationDeltas: [], changesEntity: true, changesApplication: false,
	};
}

function published(input: RibbonPublishInput): PublishedRibbonResult {
	return {
		publishedWorkspace: input.current,
		sourceSnapshot: { ...input.sourceSnapshot, capturedAt: "2026-10-15T02:00:00Z" },
		backupBase64: "UEs=", importJobId: "00000000-0000-4000-8000-000000000001",
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function setup({ entity = "account", solution = "RibbonOne", managed = false, withSource = true, dirty = true, appComponent = true }: {
	entity?: string; solution?: string; managed?: boolean; withSource?: boolean; dirty?: boolean; appComponent?: boolean;
} = {}) {
	act(() => {
		const original = workspace(entity);
		useRibbonStore.getState().loadWorkspace({ ...original, sourceSnapshot: withSource ? source(entity, solution) : null });
		if (dirty) useRibbonStore.getState().upsertLocLabel({ id: "ribbon.Label", titles: [{ languageCode: 1033, description: "Edited" }] });
		useSessionStore.setState({
			connectionUrl: ORG,
			activeEntity: { metadataId: "id", logicalName: entity, displayName: entity, isCustomEntity: false, isManaged: false, isIntersect: false },
			entities: [
				{ metadataId: "id", logicalName: entity, displayName: entity, isCustomEntity: false, isManaged: false, isIntersect: false },
				{ metadataId: "other-id", logicalName: "otherentity", displayName: "Other Entity", isCustomEntity: true, isManaged: false, isIntersect: false },
			],
			activeSolution: {
				id: "solution-id", uniqueName: solution, friendlyName: solution, version: "1.0.0.0", isManaged: managed,
				publisherId: "publisher-id", publisherUniqueName: "publisher", publisherName: "Publisher", publisherPrefix: "pub",
			},
			formRibbonScope: "entity", solutionRibbonComponentIds: appComponent ? ["application-ribbon-component"] : [],
		});
		useUIStore.setState({ bulkPublishOpen: true });
	});
	// Match App's FluentProvider/Tabster context rather than rendering an isolated
	// portal-based Dialog with no surrounding theme or accessibility provider.
	return render(<FluentProvider theme={webLightTheme}><BulkPublishModal /></FluentProvider>);
}

beforeEach(() => {
	vi.clearAllMocks();
	activatePptbRuntime();
	localStorage.clear();
	services.prepare.mockImplementation(async (input: RibbonPublishInput) => prepared(input));
	services.publish.mockImplementation(async (input: RibbonPublishInput, _progress: unknown, options: { onPrepared?: (prepared: PreparedRibbonPublish) => void }) => {
		options.onPrepared?.(prepared(input));
		return published(input);
	});
});

afterEach(async () => {
	// Explicitly detach DialogSurface and its portal subscriptions while React
	// is active. Resetting Zustand first dispatches to mounted consumers outside
	// React's act() boundary (and races Fluent UI's focus/Keyborg cleanup).
	await act(async () => {
		cleanup();
	});
	useUIStore.setState({ bulkPublishOpen: false });
	activatePptbRuntime();
	vi.restoreAllMocks();
});

describe("safe ribbon publication UI", () => {
	it("preserves the upstream Fluent publish dialog layout and visible controls", () => {
		setup();
		expect(screen.getByRole("dialog", { name: "Publish to Dataverse" })).toBeInTheDocument();
		expect(screen.getByText("Select tables to publish:")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Select all" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Deselect all" })).toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: /Include Application Ribbon/i })).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: /publish strategy/i })).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: /Solution version/i })).toHaveValue("1.0.0.0");
		expect(screen.getByRole("textbox", { name: /Publish comment/i })).toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: /Publish dependencies/i })).toBeDisabled();
		expect(screen.getByRole("button", { name: "View RibbonDiffXml" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save ZIP locally" })).toBeEnabled();
		expect(screen.getByRole("button", { name: /^Publish \(/i })).toBeEnabled();
	});

	it("keeps other solution tables listed but disables their publication", () => {
		setup();
		const loaded = screen.getByRole("checkbox", { name: "account (account)" });
		const other = screen.getByRole("checkbox", { name: "Other Entity (otherentity)" });
		expect(loaded).toBeEnabled();
		expect(loaded).toBeChecked();
		expect(other).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Select all" }));
		expect(other).not.toBeChecked();
		fireEvent.click(screen.getByRole("button", { name: "Deselect all" }));
		expect(screen.getByRole("button", { name: /^Publish \(/i })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Select all" }));
		expect(screen.getByRole("button", { name: /^Publish \(/i })).toBeEnabled();
	});

	it("blocks publishing until the current unmanaged source has been loaded", () => {
		setup({ withSource: false, dirty: false });
		expect(screen.getByText(/The unmanaged ribbon source is not available/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Publish \(/i })).toBeDisabled();
		expect(screen.getByRole("button", { name: /save ZIP locally/i })).toBeDisabled();
		expect(services.publish).not.toHaveBeenCalled();
	});

	it("refuses publishing an explicitly read-only workspace even when an older source is present", () => {
		setup();
		act(() => useRibbonStore.setState({ workspaceReadOnly: true }));
		expect(screen.getByRole("button", { name: /^Publish \(/i })).toBeDisabled();
		expect(screen.getByRole("button", { name: /save ZIP locally/i })).toBeDisabled();
		expect(screen.getByText(/The unmanaged ribbon source is not available/i)).toBeInTheDocument();
		expect(services.publish).not.toHaveBeenCalled();
	});

	it("rejects managed solutions and a source from a different organization", () => {
		const view = setup({ managed: true });
		expect(screen.getByText(/Choose an unmanaged solution/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Publish \(/i })).toBeDisabled();
		view.unmount();
		setup();
		act(() => useRibbonStore.setState({ sourceSnapshot: { ...source(), organizationUrl: "https://other.example.test/Org" } }));
		expect(screen.getByRole("button", { name: /^Publish \(/i })).toBeDisabled();
		expect(screen.getByText(/source.*organization|organization.*source|reload.*source/i)).toBeInTheDocument();
	});

	it("rejects systemform scope before either preparation or publication", () => {
		setup();
		act(() => useSessionStore.setState({ formRibbonScope: "form" }));
		expect(screen.getByText(/entity.*Form.*rules|per.systemform.*unsupported/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Publish \(/i })).toBeDisabled();
		expect(services.prepare).not.toHaveBeenCalled();
		expect(services.publish).not.toHaveBeenCalled();
	});

	it("makes exactly one publish call for the loaded entity with captured baselines", async () => {
		setup();
		fireEvent.click(screen.getByRole("button", { name: /^Publish \(/i }));
		await waitFor(() => expect(services.publish).toHaveBeenCalledTimes(1));
		const input = services.publish.mock.calls[0][0] as RibbonPublishInput;
		expect(input).toMatchObject({ organizationUrl: ORG, entityLogicalName: "account", solutionUniqueName: "RibbonOne", includeApplicationRibbon: false, strategy: "targeted" });
		expect(input.current.locLabels).toHaveLength(1);
		expect(input.baseline.locLabels).toHaveLength(0);
		expect(input.sourceSnapshot).toEqual(source());
		await screen.findByText(/Publication verified on server/i);
		expect(useRibbonStore.getState().mutationsSincePublish).toBe(0);
		expect(services.prepare).not.toHaveBeenCalled();
	});

	it("prepares and downloads a package without invoking the write path or clearing edits", async () => {
		const createObjectURL = vi.fn(() => "blob:prepared");
		const revokeObjectURL = vi.fn();
		Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
		Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
		setup();
		fireEvent.click(screen.getByRole("button", { name: /save ZIP locally/i }));
		await waitFor(() => expect(services.prepare).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
		expect(createObjectURL).toHaveBeenCalledTimes(1);
		expect(services.publish).not.toHaveBeenCalled();
		expect(useRibbonStore.getState().mutationsSincePublish).toBeGreaterThan(0);
		expect(screen.getByText(/ZIP downloaded locally. Nothing was imported or published/i)).toBeInTheDocument();
	});

	it("retains a pinned recovery ZIP after an import failure, including across modal close", async () => {
		const { RibbonPublicationError } = await import("@/services/dataverse/publishService");
		services.publish.mockImplementation(async (input: RibbonPublishInput, _progress: unknown, options: { onPrepared?: (prepared: PreparedRibbonPublish) => void }) => {
			options.onPrepared?.(prepared(input));
			throw new RibbonPublicationError("PublishXml denied", "UEs=", "00000000-0000-4000-8000-000000000001");
		});
		const names: string[] = [];
		const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function(this: HTMLAnchorElement) { names.push(this.download); });
		Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:recovery"), configurable: true });
		setup();
		fireEvent.click(screen.getByRole("button", { name: /^Publish \(/i }));
		await screen.findByText(/PublishXml denied/);
		expect(useRibbonStore.getState().mutationsSincePublish).toBeGreaterThan(0);
		const recovery = screen.getByRole("button", { name: /download recovery/i });
		fireEvent.click(recovery);
		expect(download).toHaveBeenCalledTimes(1);
		expect(names).toEqual(["CommandBarStudio_RibbonOne_account_recovery.zip"]);
		expect(document.querySelector('a[download]')?.getAttribute("download") ?? "").toBe("");
		fireEvent.click(screen.getByRole("button", { name: /cancel|close/i }));
		expect(useUIStore.getState().bulkPublishOpen).toBe(false);
		act(() => {
			useSessionStore.setState({
				activeEntity: { ...useSessionStore.getState().activeEntity!, logicalName: "contact" },
				activeSolution: { ...useSessionStore.getState().activeSolution!, uniqueName: "OtherSolution" },
			});
		});
		act(() => useUIStore.setState({ bulkPublishOpen: true }));
		expect(screen.getByRole("button", { name: /download recovery/i })).toBeInTheDocument();
		expect(screen.getByText(/Pre-change recovery ZIP available/i)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /download recovery/i }));
		expect(names).toEqual(["CommandBarStudio_RibbonOne_account_recovery.zip", "CommandBarStudio_RibbonOne_account_recovery.zip"]);
	});

	it("does not acknowledge a verified response after another workspace loads", async () => {
		const pending = deferred<PublishedRibbonResult>();
		services.publish.mockImplementation(async () => pending.promise);
		setup();
		fireEvent.click(screen.getByRole("button", { name: /^Publish \(/i }));
		await waitFor(() => expect(services.publish).toHaveBeenCalledTimes(1));
		const captured = services.publish.mock.calls[0][0] as RibbonPublishInput;
		act(() => {
			useRibbonStore.getState().loadWorkspace({ ...workspace("contact"), sourceSnapshot: source("contact") });
			useSessionStore.setState({ activeEntity: { ...useSessionStore.getState().activeEntity!, logicalName: "contact" } });
		});
		await act(async () => pending.resolve(published(captured)));
		await screen.findByText(/Publication verified on server, but the workspace changed/i);
		expect(useRibbonStore.getState().sourceSnapshot?.entityLogicalName).toBe("contact");
		expect(useRibbonStore.getState().baseline.Form.entityLogicalName).toBe("contact");
	});

	it("keeps later edits and the draft dirty even when the published snapshot verifies", async () => {
		const pending = deferred<PublishedRibbonResult>();
		services.publish.mockImplementation(async () => pending.promise);
		setup();
		fireEvent.click(screen.getByRole("button", { name: /^Publish \(/i }));
		await waitFor(() => expect(services.publish).toHaveBeenCalledTimes(1));
		const captured = services.publish.mock.calls[0][0] as RibbonPublishInput;
		act(() => useRibbonStore.getState().upsertLocLabel({ id: "later.Label", titles: [{ languageCode: 1033, description: "Later" }] }));
		localStorage.setItem("cbs:ribbon:v2:test", "preserve unsaved draft");
		await act(async () => pending.resolve(published(captured)));
		await screen.findByText(/Publication verified on server/i);
		expect(useRibbonStore.getState().mutationsSincePublish).toBeGreaterThan(0);
		expect(useRibbonStore.getState().locLabels.some((label) => label.id === "later.Label")).toBe(true);
		expect(localStorage.getItem("cbs:ribbon:v2:test")).toBe("preserve unsaved draft");
	});

	it("clears only the captured user's solution draft after a fully verified clean publish", async () => {
		setup();
		act(() => useRibbonStore.setState({ sourceSnapshot: { ...source(), userId: "crm-user-1" } }));
		const key = (userId: string) => `cbs:ribbon:v2:${[ORG, userId, "RibbonOne", "account"].map(encodeURIComponent).join(":")}`;
		localStorage.setItem(key("crm-user-1"), "this draft is published");
		localStorage.setItem(key("crm-user-2"), "another user's draft");
		fireEvent.click(screen.getByRole("button", { name: /^Publish \(/i }));
		await screen.findByText(/Publication verified on server/i);
		expect(services.publish).toHaveBeenCalledTimes(1);
		expect(localStorage.getItem(key("crm-user-1"))).toBeNull();
		expect(localStorage.getItem(key("crm-user-2"))).toBe("another user's draft");
	});

	it("requires explicit consent for application ribbon edits", async () => {
		setup();
		act(() => {
			const store = useRibbonStore.getState();
			useRibbonStore.setState({ ribbons: { ...store.ribbons, Application: { ...store.ribbons.Application, tabs: [{ id: "pub.Application.Tab", label: "App", sequence: 10, tabDisplayRules: [], groups: [] }] } } });
		});
			expect(screen.getAllByText(/Application ribbon edits require explicitly selecting/i).length).toBeGreaterThan(0);
		expect(screen.getByRole("button", { name: /^Publish \(/i })).toBeDisabled();
		fireEvent.click(screen.getByRole("checkbox", { name: /include application ribbon/i }));
		fireEvent.click(screen.getByRole("button", { name: /^Publish \(/i }));
		await waitFor(() => expect(services.publish).toHaveBeenCalledTimes(1));
		await screen.findByText(/Publication verified on server/i);
		expect((services.publish.mock.calls[0][0] as RibbonPublishInput).includeApplicationRibbon).toBe(true);
	});

	it("allows first-time Application ribbon edits with root component 50 and no exported Application XML", async () => {
		setup({ appComponent: true });
		act(() => {
			const state = useRibbonStore.getState();
			useRibbonStore.setState({
				sourceSnapshot: { ...state.sourceSnapshot!, applicationRibbonXml: null },
				ribbons: {
					...state.ribbons,
					Application: {
						...state.ribbons.Application,
						tabs: [{ id: "pub.Application.NewTab", label: "Application", sequence: 10, tabDisplayRules: [], groups: [] }],
					},
				},
			});
		});
		const consent = screen.getByRole("checkbox", { name: /include application ribbon/i });
		expect(consent).toBeEnabled();
		expect(screen.getByRole("button", { name: /^Publish \(/i })).toBeDisabled();
		fireEvent.click(consent);
		fireEvent.click(screen.getByRole("button", { name: /^Publish \(/i }));
		await waitFor(() => expect(services.publish).toHaveBeenCalledTimes(1));
		await screen.findByText(/Publication verified on server/i);
		const input = services.publish.mock.calls[0][0] as RibbonPublishInput;
		expect(input.includeApplicationRibbon).toBe(true);
		expect(input.sourceSnapshot.applicationRibbonXml).toBeNull();
		expect(input.current.ribbons.Application.tabs[0]?.id).toBe("pub.Application.NewTab");
	});

		it("disables native async-global publishing unless capability is positively available", () => {
			activateOnPremRuntime(false);
			setup();
			fireEvent.click(screen.getByRole("combobox", { name: /publish strategy/i }));
			const choice = screen.getByRole("option", { name: /async publish all/i });
			expect(choice).toHaveAttribute("aria-disabled", "true");
		expect(screen.getByText(/unavailable.*organization|organization.*unavailable/i)).toBeInTheDocument();
		expect(services.publish).not.toHaveBeenCalled();
	});

		it("warns clearly and requires an independent checkbox for optional publish-all", async () => {
			activateOnPremRuntime(true);
			setup();
			fireEvent.click(screen.getByRole("combobox", { name: /publish strategy/i }));
			fireEvent.click(screen.getByRole("option", { name: /async publish all/i }));
			expect(screen.getByText(/This publishes all customizations, including unrelated solutions/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Publish \(/i })).toBeDisabled();
		fireEvent.click(screen.getByRole("checkbox", { name: /understand.*all customizations/i }));
		fireEvent.click(screen.getByRole("button", { name: /^Publish \(/i }));
		await waitFor(() => expect(services.publish).toHaveBeenCalledTimes(1));
		await screen.findByText(/Publication verified on server/i);
		expect((services.publish.mock.calls[0][0] as RibbonPublishInput).strategy).toBe("allAsync");
	});

		it("requires fresh application/global consent when the publish dialog is reopened", () => {
			activateOnPremRuntime(true);
			setup();
			fireEvent.click(screen.getByRole("checkbox", { name: /include application ribbon/i }));
			fireEvent.click(screen.getByRole("combobox", { name: /publish strategy/i }));
			fireEvent.click(screen.getByRole("option", { name: /async publish all/i }));
		fireEvent.click(screen.getByRole("checkbox", { name: /understand.*all customizations/i }));
		fireEvent.click(screen.getByRole("button", { name: /cancel|close/i }));
		act(() => useUIStore.setState({ bulkPublishOpen: true }));
			expect(screen.getByRole("checkbox", { name: /include application ribbon/i })).not.toBeChecked();
			expect(screen.queryByRole("checkbox", { name: /understand.*all customizations/i })).toBeNull();
			fireEvent.click(screen.getByRole("combobox", { name: /publish strategy/i }));
			expect(screen.getByRole("option", { name: /targeted publish/i })).toHaveAttribute("aria-selected", "true");
		expect(services.publish).not.toHaveBeenCalled();
	});

	it("keeps custom solution version increment attached to the selected solution", async () => {
		setup();
		fireEvent.click(screen.getByRole("switch", { name: /increment solution version/i }));
		fireEvent.click(screen.getByRole("button", { name: /^Publish \(/i }));
		await waitFor(() => expect(services.publish).toHaveBeenCalledTimes(1));
		await screen.findByText(/Publication verified on server/i);
		expect((services.publish.mock.calls[0][0] as RibbonPublishInput).solutionVersion).toBe("1.0.0.1");
	});
});
