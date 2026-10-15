import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPersistedRibbonData, loadPersistedRibbonData, useRibbonPersistence } from "@/hooks/useRibbonPersistence";
import { useRibbonStore } from "@/store/ribbonStore";
import type { RibbonSourceSnapshot, RibbonWorkspace } from "@/types/workspace";

const org = "https://crm.example.test/Org";
function seed(entity = "account", solution = "RibbonOne") {
	const sourceSnapshot: RibbonSourceSnapshot = {
		organizationUrl: org, entityLogicalName: entity, solutionUniqueName: solution, solutionVersion: "1.0.0.0",
		solutionXml: "<ImportExportXml/>", customizationsXml: "<ImportExportXml/>", entityRibbonXml: "<RibbonDiffXml/>",
		applicationRibbonXml: null, capturedAt: "2026-10-15T00:00:00Z",
	};
	const value: RibbonWorkspace = {
		ribbons: {
			HomepageGrid: { location: "HomepageGrid", entityLogicalName: entity, tabs: [] },
			SubGrid: { location: "SubGrid", entityLogicalName: entity, tabs: [] },
			Form: { location: "Form", entityLogicalName: entity, tabs: [] },
			Application: { location: "Application", entityLogicalName: "{!EntityLogicalName}", tabs: [] },
		}, commands: [], displayRules: [], enableRules: [], locLabels: [],
	};
	return { ...value, sourceSnapshot };
}

describe("versioned source-bound ribbon persistence", () => {
	beforeEach(() => {
		// Node 26 also defines a process-global localStorage; isolate browser storage explicitly.
		const values = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			get length() { return values.size; },
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => { values.set(key, value); },
			removeItem: (key: string) => { values.delete(key); },
			clear: () => values.clear(), key: (index: number) => [...values.keys()][index] ?? null,
		});
		useRibbonStore.getState().loadWorkspace(seed());
	});
	afterEach(() => vi.unstubAllGlobals());

	it("saves a definition-only edit together with its original source and baseline", () => {
		const hook = renderHook(() => useRibbonPersistence());
		act(() => useRibbonStore.getState().upsertLocLabel({ id: "test.Label", titles: [{ languageCode: 1033, description: "Draft" }] }));
		const saved = loadPersistedRibbonData(org, "account", "RibbonOne");
		expect(saved?.version).toBe(2);
		expect(saved?.current.locLabels).toHaveLength(1);
		expect(saved?.baseline.locLabels).toHaveLength(0);
		expect(saved?.sourceSnapshot.organizationUrl).toBe(org);
		hook.unmount();
	});

	it("does not delete another workspace's draft when a clean workspace loads", () => {
		const hook = renderHook(() => useRibbonPersistence());
		act(() => useRibbonStore.getState().upsertLocLabel({ id: "test.Label", titles: [{ languageCode: 1033, description: "A" }] }));
		act(() => useRibbonStore.getState().loadWorkspace(seed("contact")));
		act(() => useRibbonStore.getState().upsertLocLabel({ id: "test.Label", titles: [{ languageCode: 1033, description: "B" }] }));
		act(() => useRibbonStore.getState().loadWorkspace(seed()));
		expect(loadPersistedRibbonData(org, "account", "RibbonOne")?.current.locLabels[0].titles[0].description).toBe("A");
		expect(loadPersistedRibbonData(org, "contact", "RibbonOne")?.current.locLabels[0].titles[0].description).toBe("B");
		hook.unmount();
	});

	it("separates drafts belonging to different solutions and virtual directories", () => {
		const hook = renderHook(() => useRibbonPersistence());
		act(() => useRibbonStore.getState().upsertLocLabel({ id: "test.Label", titles: [{ languageCode: 1033, description: "One" }] }));
		act(() => useRibbonStore.getState().loadWorkspace(seed("account", "RibbonTwo")));
		act(() => useRibbonStore.getState().upsertLocLabel({ id: "test.Label", titles: [{ languageCode: 1033, description: "Two" }] }));
		expect(loadPersistedRibbonData(org, "account", "RibbonOne")?.current.locLabels[0].titles[0].description).toBe("One");
		expect(loadPersistedRibbonData(org, "account", "RibbonTwo")?.current.locLabels[0].titles[0].description).toBe("Two");
		expect(loadPersistedRibbonData("https://crm.example.test/Other", "account", "RibbonOne")).toBeNull();
		clearPersistedRibbonData(org, "account", "RibbonTwo");
		expect(loadPersistedRibbonData(org, "account", "RibbonTwo")).toBeNull();
		expect(loadPersistedRibbonData(org, "account", "RibbonOne")).not.toBeNull();
		hook.unmount();
	});

	it("refuses to persist a workspace without a verified server-source identity", () => {
		act(() => useRibbonStore.getState().loadWorkspace({ ...seed(), sourceSnapshot: null }));
		const hook = renderHook(() => useRibbonPersistence());
		act(() => useRibbonStore.getState().upsertLocLabel({ id: "test.Label", titles: [{ languageCode: 1033, description: "Unsourced" }] }));
		expect(localStorage.length).toBe(0);
		hook.unmount();
	});

	it("does not persist unrelated exported solution metadata or publisher contact details", () => {
		const sourced = seed();
		sourced.sourceSnapshot.customizationsXml = '<ImportExportXml><Entities><Entity><Secret>UNRELATED-SCHEMA</Secret></Entity></Entities></ImportExportXml>';
		sourced.sourceSnapshot.solutionXml = '<ImportExportXml><SolutionManifest><Publisher><UniqueName>testpub</UniqueName><CustomizationPrefix>test</CustomizationPrefix><CustomizationOptionValuePrefix>78123</CustomizationOptionValuePrefix><EMailAddress>PRIVATE-CONTACT</EMailAddress></Publisher></SolutionManifest></ImportExportXml>';
		useRibbonStore.getState().loadWorkspace(sourced);
		const hook = renderHook(() => useRibbonPersistence());
		act(() => useRibbonStore.getState().upsertLocLabel({ id: "test.Label", titles: [{ languageCode: 1033, description: "Draft" }] }));
		const raw = localStorage.getItem(localStorage.key(0)!);
		expect(raw).not.toContain("UNRELATED-SCHEMA");
		expect(raw).not.toContain("PRIVATE-CONTACT");
		expect(raw).toContain("78123");
		hook.unmount();
	});

	it("separates drafts from different signed-in CRM users", () => {
		const sourced = seed(); sourced.sourceSnapshot.userId = "user-one";
		useRibbonStore.getState().loadWorkspace(sourced);
		const hook = renderHook(() => useRibbonPersistence());
		act(() => useRibbonStore.getState().upsertLocLabel({ id: "test.Label", titles: [{ languageCode: 1033, description: "User one" }] }));
		expect(loadPersistedRibbonData(org, "account", "RibbonOne", "user-one")).not.toBeNull();
		expect(loadPersistedRibbonData(org, "account", "RibbonOne", "user-two")).toBeNull();
		hook.unmount();
	});
});
