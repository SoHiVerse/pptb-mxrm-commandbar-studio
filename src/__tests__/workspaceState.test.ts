import { beforeEach, describe, expect, it } from "vitest";
import { useRibbonStore } from "@/store/ribbonStore";
import type { RibbonSourceSnapshot, RibbonWorkspace } from "@/types/workspace";

function workspace(entity = "account"): RibbonWorkspace {
	return {
		ribbons: {
			HomepageGrid: { location: "HomepageGrid", entityLogicalName: entity, tabs: [] },
			SubGrid: { location: "SubGrid", entityLogicalName: entity, tabs: [] },
			Form: { location: "Form", entityLogicalName: entity, tabs: [] },
			Application: { location: "Application", entityLogicalName: "{!EntityLogicalName}", tabs: [] },
		},
		commands: [{ id: "test.Command", actions: [{ kind: "url", address: "https://example.test/a", passParams: false, params: [] }], enableRules: ["test.Rule"], displayRules: [] }],
		enableRules: [{ id: "test.Rule", steps: [{ kind: "SelectionCountRule", minimum: 1 }] }],
		displayRules: [],
		locLabels: [{ id: "test.Label", titles: [{ languageCode: 1033, description: "Before" }] }],
	};
}

function source(entity = "account"): RibbonSourceSnapshot {
	return {
		solutionUniqueName: "testSolution", entityLogicalName: entity, solutionVersion: "1.0.0.0",
		solutionXml: "<ImportExportXml><SolutionManifest/></ImportExportXml>",
		customizationsXml: "<ImportExportXml/>", entityRibbonXml: "<RibbonDiffXml/>", applicationRibbonXml: null,
		capturedAt: "2026-10-15T00:00:00Z",
	};
}

describe("workspace definition baselines and publication boundaries", () => {
	beforeEach(() => useRibbonStore.getState().loadWorkspace({ ...workspace(), sourceSnapshot: source() }));

	it("captures an independent immutable definition baseline", () => {
		const state = useRibbonStore.getState();
		expect(state.baselineDefinitions.commands).toEqual(state.commands);
		expect(state.baselineDefinitions.commands).not.toBe(state.commands);
		const changed = structuredClone(state.commands[0]);
		changed.actions = [{ kind: "url", address: "https://example.test/b", passParams: false, params: [] }];
		state.upsertCommand(changed);
		expect(useRibbonStore.getState().baselineDefinitions.commands[0].actions[0]).toMatchObject({ address: "https://example.test/a" });
	});

	it("undoes and redoes a command-only edit without changing its baseline", () => {
		const changed = structuredClone(useRibbonStore.getState().commands[0]);
		changed.actions = [];
		useRibbonStore.getState().upsertCommand(changed);
		useRibbonStore.getState().undo();
		expect(useRibbonStore.getState().commands[0].actions).toHaveLength(1);
		expect(useRibbonStore.getState().mutationsSincePublish).toBe(0);
		useRibbonStore.getState().redo();
		expect(useRibbonStore.getState().commands[0].actions).toHaveLength(0);
		expect(useRibbonStore.getState().baselineDefinitions.commands[0].actions).toHaveLength(1);
		expect(useRibbonStore.getState().mutationsSincePublish).toBeGreaterThan(0);
	});

	it("tracks label edits as dirty and includes them in history", () => {
		useRibbonStore.getState().upsertLocLabel({ id: "test.Label", titles: [{ languageCode: 1033, description: "After" }] });
		expect(useRibbonStore.getState().mutationsSincePublish).toBeGreaterThan(0);
		useRibbonStore.getState().undo();
		expect(useRibbonStore.getState().locLabels[0].titles[0].description).toBe("Before");
	});

	it("acknowledges only the published snapshot and keeps later edits dirty", () => {
		const published = workspace();
		published.locLabels[0].titles[0].description = "Published";
		useRibbonStore.getState().upsertLocLabel(published.locLabels[0]);
		useRibbonStore.getState().upsertLocLabel({ id: "test.Label", titles: [{ languageCode: 1033, description: "Later edit" }] });
		useRibbonStore.getState().markPublished(published, source());
		expect(useRibbonStore.getState().baselineDefinitions.locLabels[0].titles[0].description).toBe("Published");
		expect(useRibbonStore.getState().locLabels[0].titles[0].description).toBe("Later edit");
		expect(useRibbonStore.getState().mutationsSincePublish).toBeGreaterThan(0);
	});

	it("refuses publication completion from a previously selected entity", () => {
		const previous = workspace();
		useRibbonStore.getState().loadWorkspace({ ...workspace("contact"), sourceSnapshot: source("contact") });
		expect(() => useRibbonStore.getState().markPublished(previous, source())).toThrow(/workspace|entity|changed/i);
		expect(useRibbonStore.getState().baseline.Form.entityLogicalName).toBe("contact");
	});

	it("restores editable draft state without making it the published baseline", () => {
		const current = workspace();
		current.commands[0].actions = [];
		useRibbonStore.getState().restoreDraft({ version: 2, current, baseline: workspace(), sourceSnapshot: source(), savedAt: "2026-10-15T01:00:00Z" });
		expect(useRibbonStore.getState().commands[0].actions).toHaveLength(0);
		expect(useRibbonStore.getState().baselineDefinitions.commands[0].actions).toHaveLength(1);
		expect(useRibbonStore.getState().mutationsSincePublish).toBeGreaterThan(0);
	});

	it("rejects a draft belonging to a different solution", () => {
		const otherSource = { ...source(), solutionUniqueName: "otherSolution" };
		expect(() => useRibbonStore.getState().restoreDraft({ version: 2, current: workspace(), baseline: workspace(), sourceSnapshot: otherSource, savedAt: "2026-10-15T01:00:00Z" })).toThrow(/solution|workspace|match/i);
	});

	it("rejects a draft after its server source changed", () => {
		const old = source();
		old.entityRibbonXml = '<RibbonDiffXml><CustomActions><HideCustomAction HideActionId="x" Location="y"/></CustomActions></RibbonDiffXml>';
		expect(() => useRibbonStore.getState().restoreDraft({ version: 2, current: workspace(), baseline: workspace(), sourceSnapshot: old, savedAt: "2026-10-15T01:00:00Z" })).toThrow(/changed|conflict|baseline/i);
	});

	it("rejects a draft from an earlier solution version even when its ribbons match", () => {
		const old = { ...source(), solutionVersion: "0.9.0.0" };
		expect(() => useRibbonStore.getState().restoreDraft({ version: 2, current: workspace(), baseline: workspace(), sourceSnapshot: old, savedAt: "2026-10-15T01:00:00Z" })).toThrow(/version|publisher|changed/i);
	});

	it("rejects a draft after publisher metadata changed", () => {
		const old = { ...source(), solutionXml: "<ImportExportXml><SolutionManifest><Publisher><CustomizationOptionValuePrefix>78123</CustomizationOptionValuePrefix></Publisher></SolutionManifest></ImportExportXml>" };
		expect(() => useRibbonStore.getState().restoreDraft({ version: 2, current: workspace(), baseline: workspace(), sourceSnapshot: old, savedAt: "2026-10-15T01:00:00Z" })).toThrow(/version|publisher|changed/i);
	});

	it("rejects publication completion after reloading the same entity and solution", () => {
		const generation = useRibbonStore.getState().workspaceGeneration;
		useRibbonStore.getState().loadWorkspace({ ...workspace(), sourceSnapshot: source() });
		expect(() => useRibbonStore.getState().markPublished(workspace(), source(), generation)).toThrow(/reload|workspace|changed/i);
	});

	it("applies an imported workspace as one undoable edit without changing source or baseline", () => {
		const before = useRibbonStore.getState();
		const current = workspace(); current.commands[0].actions = [];
		before.applyWorkspaceEdit(current, "Import XML");
		expect(useRibbonStore.getState().sourceSnapshot).toBe(before.sourceSnapshot);
		expect(useRibbonStore.getState().baselineDefinitions.commands[0].actions).toHaveLength(1);
		expect(useRibbonStore.getState().past).toHaveLength(1);
		expect(useRibbonStore.getState().mutationsSincePublish).toBeGreaterThan(0);
		useRibbonStore.getState().undo();
		expect(useRibbonStore.getState().commands[0].actions).toHaveLength(1);
	});

	it("keeps local editing available when source export fails, without inventing publication authority", () => {
		useRibbonStore.getState().loadWorkspace({ ...workspace(), sourceSnapshot: null });
		expect(useRibbonStore.getState().workspaceReadOnly).toBe(false);
		useRibbonStore.getState().upsertLocLabel({ id: "test.New", titles: [] });
		expect(useRibbonStore.getState().mutationsSincePublish).toBeGreaterThan(0);
		expect(useRibbonStore.getState().sourceSnapshot).toBeNull();
		useRibbonStore.getState().undo();
		expect(useRibbonStore.getState().mutationsSincePublish).toBe(0);
	});

	it("adopts verified caches and generated labels without leaving an unchanged workspace dirty", () => {
		const submitted = workspace();
		const rebased = structuredClone(submitted);
		rebased.commands[0].sourceXml = '<CommandDefinition Id="test.Command"><Actions><Url Address="https://example.test/a"/></Actions></CommandDefinition>';
		rebased.locLabels.push({ id: "test.Generated", titles: [{ languageCode: 1033, description: "Generated" }], sourceXml: '<LocLabel Id="test.Generated"><Titles><Title languagecode="1033" description="Generated"/></Titles></LocLabel>' });
		useRibbonStore.getState().markPublished(rebased, source(), useRibbonStore.getState().workspaceGeneration, submitted);
		expect(useRibbonStore.getState().commands[0].sourceXml).toBe(rebased.commands[0].sourceXml);
		expect(useRibbonStore.getState().locLabels).toHaveLength(2);
		expect(useRibbonStore.getState().mutationsSincePublish).toBe(0);
	});

	it("updates verified caches without overwriting a later modeled edit", () => {
		const submitted = workspace();
		const rebased = structuredClone(submitted);
		rebased.commands[0].sourceXml = '<CommandDefinition Id="test.Command"><Actions><Url Address="https://example.test/a"/></Actions></CommandDefinition>';
		const later = structuredClone(submitted.commands[0]);
		later.actions = [{ kind: "url", address: "https://example.test/later", passParams: false, params: [] }];
		useRibbonStore.getState().upsertCommand(later);
		useRibbonStore.getState().markPublished(rebased, source(), useRibbonStore.getState().workspaceGeneration, submitted);
		expect(useRibbonStore.getState().commands[0].actions[0]).toMatchObject({ address: "https://example.test/later" });
		expect(useRibbonStore.getState().commands[0].sourceXml).toBe(rebased.commands[0].sourceXml);
		expect(useRibbonStore.getState().mutationsSincePublish).toBeGreaterThan(0);
	});
});
