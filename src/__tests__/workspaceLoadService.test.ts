import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseRibbonXml } from "@/services/xmlParser";
import { getBaselineWorkspace, getEditableWorkspace, useRibbonStore } from "@/store/ribbonStore";
import type { RibbonSourceSnapshot, RibbonWorkspace } from "@/types/workspace";

const { source, merged } = vi.hoisted(() => ({ source: vi.fn(), merged: vi.fn() }));
vi.mock("@/services/dataverse/ribbonSourceService", () => ({ fetchRibbonSource: source }));
vi.mock("@/services/dataverse/ribbonService", () => ({ fetchRibbonWorkspace: merged }));
import { fetchSourceBoundWorkspace } from "@/services/dataverse/workspaceLoadService";

const token = "Lead.Appo.Btn.Home.LabelText";

function sourceSnapshot(xml = `<RibbonDiffXml><LocLabels><LocLabel Id="${token}"><Titles>
  <Title languagecode="1033" description="Set Reminder"/><Title languagecode="1065" description="تنظیم یادآوری"/>
</Titles></LocLabel></LocLabels></RibbonDiffXml>`): RibbonSourceSnapshot {
  return {
    organizationUrl: "https://crm.example.test", entityLogicalName: "lead", solutionUniqueName: "Ribbon",
    solutionVersion: "1.0.0.0", solutionXml: "<ImportExportXml/>", customizationsXml: "<ImportExportXml/>",
    entityRibbonXml: xml, applicationRibbonXml: null, capturedAt: "2026-10-15T02:00:00Z",
  };
}

function mergedWorkspace(): RibbonWorkspace {
  const parsed = parseRibbonXml(`<RibbonDefinitions><RibbonDefinition><Tabs>
    <Tab Id="Lead.Home" Title="My Leads"><Groups><Group Id="Lead.Home.Group" Title="Operations">
      <Controls><Button Id="Lead.Home.Reminder" Command="Lead.Reminder.Command" LabelText="$LocLabels:${token}" Sequence="10"/></Controls>
    </Group></Groups></Tab>
  </Tabs></RibbonDefinition><CommandDefinitions>
    <CommandDefinition Id="Lead.Reminder.Command"><Actions><Url Address="/reminders"/></Actions></CommandDefinition>
  </CommandDefinitions></RibbonDefinitions>`, "HomepageGrid", "lead");
  return {
    ribbons: {
      HomepageGrid: parsed.ribbon,
      Form: { location: "Form", entityLogicalName: "lead", tabs: [] },
      SubGrid: { location: "SubGrid", entityLogicalName: "lead", tabs: [] },
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
    const pending = fetchSourceBoundWorkspace("Ribbon", "lead", "https://crm.example.test");
    expect(source).toHaveBeenCalledWith("Ribbon", "lead", "https://crm.example.test");
    expect(merged).not.toHaveBeenCalled();
    finish(sourceSnapshot());
    const result = await pending;
    expect(merged).toHaveBeenCalledWith("lead");
    expect(result.sourceSnapshot?.entityLogicalName).toBe("lead");
    expect(result.workspace.ribbons.HomepageGrid.tabs[0].groups[0].buttons[0].label).toBe("Set Reminder");
  });

  it("hydrates before the initial baseline is stored, keeping diff empty and history clean", async () => {
    source.mockResolvedValueOnce(sourceSnapshot());
    merged.mockResolvedValueOnce(mergedWorkspace());
    const result = await fetchSourceBoundWorkspace("Ribbon", "lead", "https://crm.example.test");
    expect(result.workspace.locLabels).toMatchObject([{
      id: token, titles: [
        { languageCode: 1033, description: "Set Reminder" },
        { languageCode: 1065, description: "تنظیم یادآوری" },
      ],
    }]);
    expect(result.workspace.commands[0].actions[0]).toMatchObject({ kind: "url", address: "/reminders" });
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
    const result = await fetchSourceBoundWorkspace("Ribbon", "lead", "https://crm.example.test");
    expect(result.sourceSnapshot).toBeNull();
    expect(result.sourceError).toContain("Export privilege missing");
    expect(merged).toHaveBeenCalledOnce();
    expect(result.workspace.locLabels).toHaveLength(0);
    expect(result.workspace.ribbons.HomepageGrid.tabs[0].groups[0].buttons[0].label).toBe(token);
  });
});
