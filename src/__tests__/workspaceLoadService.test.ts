import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseRibbonXml } from "@/services/xmlParser";
import { getBaselineWorkspace, getEditableWorkspace, useRibbonStore } from "@/store/ribbonStore";
import type { RibbonSourceSnapshot, RibbonWorkspace } from "@/types/workspace";

const { source, merged } = vi.hoisted(() => ({ source: vi.fn(), merged: vi.fn() }));
vi.mock("@/services/dataverse/ribbonSourceService", () => ({ fetchRibbonSource: source }));
vi.mock("@/services/dataverse/ribbonService", () => ({ fetchRibbonWorkspace: merged }));
import { fetchSourceBoundWorkspace } from "@/services/dataverse/workspaceLoadService";

const token = "Sample.Ribbon.Home.ReviewLabel";

function sourceSnapshot(xml = `<RibbonDiffXml><LocLabels><LocLabel Id="${token}"><Titles>
  <Title languagecode="1033" description="Review Record"/><Title languagecode="1065" description="بررسی رکورد"/>
</Titles></LocLabel></LocLabels></RibbonDiffXml>`): RibbonSourceSnapshot {
  return {
    organizationUrl: "https://example.test/sample-org", entityLogicalName: "sample", solutionUniqueName: "SampleSolution",
    solutionVersion: "1.0.0.0", solutionXml: "<ImportExportXml/>", customizationsXml: "<ImportExportXml/>",
    entityRibbonXml: xml, applicationRibbonXml: null, capturedAt: "2026-01-01T00:00:00Z",
  };
}

function mergedWorkspace(): RibbonWorkspace {
  const parsed = parseRibbonXml(`<RibbonDefinitions><RibbonDefinition><Tabs>
    <Tab Id="Sample.Home" Title="Sample Records"><Groups><Group Id="Sample.Home.Group" Title="Operations">
      <Controls><Button Id="Sample.Home.Review" Command="Sample.Review.Command" LabelText="$LocLabels:${token}" Sequence="10"/></Controls>
    </Group></Groups></Tab>
  </Tabs></RibbonDefinition><CommandDefinitions>
    <CommandDefinition Id="Sample.Review.Command"><Actions><Url Address="/reviews"/></Actions></CommandDefinition>
  </CommandDefinitions></RibbonDefinitions>`, "HomepageGrid", "sample");
  return {
    ribbons: {
      HomepageGrid: parsed.ribbon,
      Form: { location: "Form", entityLogicalName: "sample", tabs: [] },
      SubGrid: { location: "SubGrid", entityLogicalName: "sample", tabs: [] },
      Application: { location: "Application", entityLogicalName: "{!EntityLogicalName}", tabs: [] },
    },
    commands: parsed.commands,
    displayRules: parsed.displayRules,
    enableRules: parsed.enableRules,
    locLabels: parsed.locLabels,
  };
}

describe("source-bound workspace load order and label hydration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("captures the unmanaged source before reading the merged display model", async () => {
    let finish!: (value: RibbonSourceSnapshot) => void;
    source.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    merged.mockResolvedValueOnce(mergedWorkspace());
    const pending = fetchSourceBoundWorkspace("SampleSolution", "sample", "https://example.test/sample-org");
    expect(source).toHaveBeenCalledWith("SampleSolution", "sample", "https://example.test/sample-org");
    expect(merged).not.toHaveBeenCalled();
    finish(sourceSnapshot());
    const result = await pending;
    expect(merged).toHaveBeenCalledWith("sample");
    expect(result.sourceSnapshot?.entityLogicalName).toBe("sample");
    expect(result.workspace.ribbons.HomepageGrid.tabs[0].groups[0].buttons[0].label).toBe("Review Record");
  });

  it("hydrates before the initial baseline is stored, keeping diff empty and history clean", async () => {
    source.mockResolvedValueOnce(sourceSnapshot());
    merged.mockResolvedValueOnce(mergedWorkspace());
    const result = await fetchSourceBoundWorkspace("SampleSolution", "sample", "https://example.test/sample-org");
    expect(result.workspace.locLabels).toMatchObject([{
      id: token, titles: [
        { languageCode: 1033, description: "Review Record" },
        { languageCode: 1065, description: "بررسی رکورد" },
      ],
    }]);
    expect(result.workspace.commands[0].actions[0]).toMatchObject({ kind: "url", address: "/reviews" });
    useRibbonStore.getState().loadWorkspace({ ...result.workspace, sourceSnapshot: result.sourceSnapshot });
    const state = useRibbonStore.getState();
    expect(getEditableWorkspace(state)).toEqual(getBaselineWorkspace(state));
    expect(state.baselineDefinitions.locLabels[0].titles).toEqual(result.workspace.locLabels[0].titles);
    expect(state.mutationsSincePublish).toBe(0);
    expect(state.past).toHaveLength(0);
    expect(state.future).toHaveLength(0);
    expect(state.sourceSnapshot).toEqual(result.sourceSnapshot);
  });

  it("makes source failure explicit while still allowing an unhydrated read-only merged view", async () => {
    source.mockRejectedValueOnce(new Error("Export privilege missing"));
    merged.mockResolvedValueOnce(mergedWorkspace());
    const result = await fetchSourceBoundWorkspace("SampleSolution", "sample", "https://example.test/sample-org");
    expect(result.sourceSnapshot).toBeNull();
    expect(result.sourceError).toContain("Export privilege missing");
    expect(merged).toHaveBeenCalledOnce();
    expect(result.workspace.locLabels).toHaveLength(0);
    expect(result.workspace.ribbons.HomepageGrid.tabs[0].groups[0].buttons[0].label).toBe(token);
  });
});
