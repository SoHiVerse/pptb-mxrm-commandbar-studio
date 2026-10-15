import { describe, expect, it } from "vitest";
import { parseRibbonXml } from "@/services/xmlParser";
import { hydrateRibbonLabels } from "@/services/hydrateRibbonLabels";
import type { RibbonSourceSnapshot, RibbonWorkspace } from "@/types/workspace";

const LABEL = "Lead.Appo.Btn.Home.LabelText";
const entityXml = `<RibbonDiffXml><LocLabels>
  <LocLabel Id="${LABEL}"><Titles>
    <Title languagecode="1033" description="Set Reminder"/>
    <Title languagecode="1065" description="تنظیم یادآوری"/>
  </Titles></LocLabel>
  <LocLabel Id="Lead.Tab.Title"><Titles><Title languagecode="1033" description="My Leads"/></Titles></LocLabel>
  <LocLabel Id="Lead.Group.Title"><Titles><Title languagecode="1033" description="Lead Actions"/></Titles></LocLabel>
  <LocLabel Id="Lead.Tooltip.Title"><Titles><Title languagecode="1033" description="Reminder actions"/></Titles></LocLabel>
  <LocLabel Id="Lead.Tooltip.Body"><Titles><Title languagecode="1033" description="Schedule a reminder"/></Titles></LocLabel>
</LocLabels></RibbonDiffXml>`;

const appXml = `<RibbonDiffXml><LocLabels>
  <LocLabel Id="${LABEL}"><Titles>
    <Title languagecode="1033" description="Wrong global label"/>
    <Title languagecode="1031" description="Erinnerung planen"/>
  </Titles></LocLabel>
  <LocLabel Id="Application.Only"><Titles>
    <Title languagecode="1033" description="Application Command"/>
    <Title languagecode="1065" description="دستور عمومی"/>
  </Titles></LocLabel>
</LocLabels></RibbonDiffXml>`;

const mergedLeadXml = `<RibbonDefinitions><RibbonDefinition><Tabs>
  <Tab Id="Lead.Home.Tab" Title="$LocLabels:Lead.Tab.Title" Sequence="10">
    <Groups><Group Id="Lead.Group" Title="$LocLabels:Lead.Group.Title" Sequence="10">
      <Controls>
        <Button Id="Lead.Home.Reminder" LabelText="$LocLabels:${LABEL}"
          ToolTipTitle="$LocLabels:Lead.Tooltip.Title" ToolTipDescription="$LocLabels:Lead.Tooltip.Body"
          Sequence="10" TemplateAlias="o1" Command="Lead.Command" />
        <Button Id="Mscrm.Save" LabelText="$Resources:Ribbon.HomepageGrid.Save" Sequence="20"/>
      </Controls>
    </Group></Groups>
  </Tab>
</Tabs></RibbonDefinition><CommandDefinitions><CommandDefinition Id="Lead.Command">
  <EnableRules><EnableRule Id="Lead.Enabled"/></EnableRules><Actions><JavaScriptFunction Library="$webresource:lead/actions.js" FunctionName="remind"/></Actions>
</CommandDefinition></CommandDefinitions><RuleDefinitions><EnableRules><EnableRule Id="Lead.Enabled"><SelectionCountRule Minimum="1"/></EnableRule></EnableRules></RuleDefinitions></RibbonDefinitions>`;

const mergedAppXml = `<RibbonDefinitions><RibbonDefinition><Tabs>
  <Tab Id="Mscrm.GlobalTab" Title="Global"><Groups><Group Id="Mscrm.GlobalGroup" Title="Actions">
    <Controls><Button Id="Global.App" LabelText="$LocLabels:Application.Only" Sequence="10" /></Controls>
  </Group></Groups></Tab>
</Tabs></RibbonDefinition></RibbonDefinitions>`;

function workspace(): RibbonWorkspace {
  const entity = parseRibbonXml(mergedLeadXml, "HomepageGrid", "lead");
  const application = parseRibbonXml(mergedAppXml, "Application", "{!EntityLogicalName}");
  expect(entity.locLabels).toHaveLength(0); // The observed on-prem RetrieveEntityRibbon shape.
  return {
    ribbons: {
      HomepageGrid: entity.ribbon,
      SubGrid: { location: "SubGrid", entityLogicalName: "lead", tabs: [] },
      Form: { location: "Form", entityLogicalName: "lead", tabs: [] },
      Application: application.ribbon,
    },
    commands: entity.commands,
    enableRules: entity.enableRules,
    displayRules: entity.displayRules,
    locLabels: [],
  };
}

function source(): RibbonSourceSnapshot {
  return {
    organizationUrl: "https://crm.example.test/Org", solutionUniqueName: "Ribbon", entityLogicalName: "lead",
    solutionVersion: "1.0.0.0", solutionXml: "<ImportExportXml/>", customizationsXml: "<ImportExportXml/>",
    entityRibbonXml: entityXml, applicationRibbonXml: appXml, capturedAt: "2026-10-15T01:00:00Z",
  };
}

describe("hydrateRibbonLabels", () => {
  it("resolves real custom Lead labels and tooltips absent from the merged ribbon", () => {
    const loaded = workspace();
    const original = structuredClone(loaded);
    expect(loaded.ribbons.HomepageGrid.tabs[0].groups[0].buttons[0].label).toBe(LABEL);
    const hydrated = hydrateRibbonLabels(loaded, source());
    const tab = hydrated.ribbons.HomepageGrid.tabs[0];
    const group = tab.groups[0];
    const reminder = group.buttons[0];
    expect(tab.label).toBe("My Leads");
    expect(group.label).toBe("Lead Actions");
    expect(reminder.label).toBe("Set Reminder");
    expect(reminder.tooltipTitle).toBe("Reminder actions");
    expect(reminder.tooltipBody).toBe("Schedule a reminder");
    expect(group.buttons[1].label).toBe("Ribbon.HomepageGrid.Save");
    expect(hydrated.ribbons.Application.tabs[0].groups[0].buttons[0].label).toBe("Application Command");
    expect(loaded).toEqual(original); // Pure: the loader's source model is unmodified.
  });

  it("retains English, Persian, other locales, sourceXml and entity-first translation precedence", () => {
    const hydrated = hydrateRibbonLabels(workspace(), source());
    const reminder = hydrated.locLabels.find(label => label.id === LABEL)!;
    expect(reminder.titles).toEqual([
      { languageCode: 1033, description: "Set Reminder" },
      { languageCode: 1065, description: "تنظیم یادآوری" },
      { languageCode: 1031, description: "Erinnerung planen" },
    ]);
    expect(reminder.sourceXml).toContain('<LocLabel Id="Lead.Appo.Btn.Home.LabelText">');
    expect(reminder.sourceXml).toContain('languagecode="1065"');
    const global = hydrated.locLabels.find(label => label.id === "Application.Only")!;
    expect(global.titles).toEqual([
      { languageCode: 1033, description: "Application Command" },
      { languageCode: 1065, description: "دستور عمومی" },
    ]);
    expect(global.sourceXml).toContain("Application.Only");
    expect(hydrated.locLabels.map(label => label.id)).toEqual([
      LABEL, "Lead.Tab.Title", "Lead.Group.Title", "Lead.Tooltip.Title", "Lead.Tooltip.Body", "Application.Only",
    ]);
  });

  it("keeps distinct merged platform labels and missing translations without overriding source precedence", () => {
    const input = workspace();
    const platform = { id: "Mscrm.PlatformSave", titles: [{ languageCode: 1033, description: "Save" }],
      sourceXml: '<LocLabel Id="Mscrm.PlatformSave"><Titles><Title languagecode="1033" description="Save"/></Titles></LocLabel>' };
    input.locLabels.push({ id: LABEL, titles: [
      { languageCode: 1033, description: "Stale merged label" },
      { languageCode: 1041, description: "リマインダー" },
    ], sourceXml: '<LocLabel Id="Lead.Appo.Btn.Home.LabelText" Origin="Merged"/>' }, platform);
    const hydrated = hydrateRibbonLabels(input, source());
    const primary = hydrated.locLabels.find(label => label.id === LABEL)!;
    expect(primary.titles).toEqual([
      { languageCode: 1033, description: "Set Reminder" },
      { languageCode: 1065, description: "تنظیم یادآوری" },
      { languageCode: 1031, description: "Erinnerung planen" },
      { languageCode: 1041, description: "リマインダー" },
    ]);
    expect(primary.sourceXml).not.toContain('Origin="Merged"');
    expect(hydrated.locLabels.find(label => label.id === platform.id)).toEqual(platform);
    expect(input.locLabels[0].titles[0].description).toBe("Stale merged label");
  });

  it("leaves command, rules and every raw ribbon sourceXml subtree untouched", () => {
    const original = workspace();
    const hydrated = hydrateRibbonLabels(original, source());
    expect(hydrated.commands).toEqual(original.commands);
    expect(hydrated.enableRules).toEqual(original.enableRules);
    expect(hydrated.displayRules).toEqual(original.displayRules);
    for (const location of ["HomepageGrid", "SubGrid", "Form", "Application"] as const) {
      const origRibbon = original.ribbons[location];
      const resultRibbon = hydrated.ribbons[location];
      expect(resultRibbon).toMatchObject({ location: origRibbon.location, entityLogicalName: origRibbon.entityLogicalName });
      for (let tabIndex = 0; tabIndex < origRibbon.tabs.length; tabIndex++) {
        const tab = origRibbon.tabs[tabIndex];
        const resultTab = resultRibbon.tabs[tabIndex];
        expect(resultTab.sourceXml).toBe(tab.sourceXml);
        expect(resultTab.groups.map(group => group.sourceXml)).toEqual(tab.groups.map(group => group.sourceXml));
        expect(resultTab.groups.map(group => group.buttons.map(button => button.sourceXml)))
          .toEqual(tab.groups.map(group => group.buttons.map(button => button.sourceXml)));
      }
    }
  });

  it("returns the unchanged merged workspace when no unmanaged source was exported", () => {
    const original = workspace();
    expect(hydrateRibbonLabels(original, null)).toBe(original);
    expect(original.ribbons.HomepageGrid.tabs[0].groups[0].buttons[0].label).toBe(LABEL);
    expect(original.locLabels).toHaveLength(0);
  });

  it("rejects a source for a different entity instead of hydrating another workspace", () => {
    const original = workspace();
    expect(() => hydrateRibbonLabels(original, { ...source(), entityLogicalName: "account" })).toThrow(/entity|source|workspace/i);
    expect(original.locLabels).toHaveLength(0);
  });
});
