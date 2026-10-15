import { describe, expect, it } from "vitest";
import { parseRibbonXml } from "@/services/xmlParser";
import { hydrateRibbonLabels } from "@/services/hydrateRibbonLabels";
import type { RibbonSourceSnapshot, RibbonWorkspace } from "@/types/workspace";

const LABEL = "Sample.Ribbon.Home.ReviewLabel";
const entityXml = `<RibbonDiffXml><LocLabels>
  <LocLabel Id="${LABEL}"><Titles>
    <Title languagecode="1033" description="Review Record"/>
    <Title languagecode="1065" description="بررسی رکورد"/>
  </Titles></LocLabel>
  <LocLabel Id="Sample.Tab.Title"><Titles><Title languagecode="1033" description="Sample Records"/></Titles></LocLabel>
  <LocLabel Id="Sample.Group.Title"><Titles><Title languagecode="1033" description="Record Actions"/></Titles></LocLabel>
  <LocLabel Id="Sample.Tooltip.Title"><Titles><Title languagecode="1033" description="Review this record"/></Titles></LocLabel>
  <LocLabel Id="Sample.Tooltip.Body"><Titles><Title languagecode="1033" description="Open the record review"/></Titles></LocLabel>
</LocLabels></RibbonDiffXml>`;

const appXml = `<RibbonDiffXml><LocLabels>
  <LocLabel Id="${LABEL}"><Titles>
    <Title languagecode="1033" description="Wrong global label"/>
    <Title languagecode="1031" description="Datensatz prüfen"/>
  </Titles></LocLabel>
  <LocLabel Id="Application.Only"><Titles>
    <Title languagecode="1033" description="Application Command"/>
    <Title languagecode="1065" description="دستور عمومی"/>
  </Titles></LocLabel>
</LocLabels></RibbonDiffXml>`;

const mergedSampleXml = `<RibbonDefinitions><RibbonDefinition><Tabs>
  <Tab Id="Sample.Home.Tab" Title="$LocLabels:Sample.Tab.Title" Sequence="10">
    <Groups><Group Id="Sample.Group" Title="$LocLabels:Sample.Group.Title" Sequence="10">
      <Controls>
        <Button Id="Sample.Home.Review" LabelText="$LocLabels:${LABEL}"
          ToolTipTitle="$LocLabels:Sample.Tooltip.Title" ToolTipDescription="$LocLabels:Sample.Tooltip.Body"
          Sequence="10" TemplateAlias="o1" Command="Sample.Command" />
        <Button Id="Mscrm.Save" LabelText="$Resources:Ribbon.HomepageGrid.Save" Sequence="20"/>
      </Controls>
    </Group></Groups>
  </Tab>
</Tabs></RibbonDefinition><CommandDefinitions><CommandDefinition Id="Sample.Command">
  <EnableRules><EnableRule Id="Sample.Enabled"/></EnableRules><Actions><JavaScriptFunction Library="$webresource:sample_/actions.js" FunctionName="review"/></Actions>
</CommandDefinition></CommandDefinitions><RuleDefinitions><EnableRules><EnableRule Id="Sample.Enabled"><SelectionCountRule Minimum="1"/></EnableRule></EnableRules></RuleDefinitions></RibbonDefinitions>`;

const mergedAppXml = `<RibbonDefinitions><RibbonDefinition><Tabs>
  <Tab Id="Mscrm.GlobalTab" Title="Global"><Groups><Group Id="Mscrm.GlobalGroup" Title="Actions">
    <Controls><Button Id="Global.App" LabelText="$LocLabels:Application.Only" Sequence="10" /></Controls>
  </Group></Groups></Tab>
</Tabs></RibbonDefinition></RibbonDefinitions>`;

function workspace(): RibbonWorkspace {
  const entity = parseRibbonXml(mergedSampleXml, "HomepageGrid", "sample");
  const application = parseRibbonXml(mergedAppXml, "Application", "{!EntityLogicalName}");
  expect(entity.locLabels).toHaveLength(0); // The merged RetrieveEntityRibbon response can omit LocLabels.
  return {
    ribbons: {
      HomepageGrid: entity.ribbon,
      SubGrid: { location: "SubGrid", entityLogicalName: "sample", tabs: [] },
      Form: { location: "Form", entityLogicalName: "sample", tabs: [] },
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
    organizationUrl: "https://example.test/sample-org", solutionUniqueName: "SampleSolution", entityLogicalName: "sample",
    solutionVersion: "1.0.0.0", solutionXml: "<ImportExportXml/>", customizationsXml: "<ImportExportXml/>",
    entityRibbonXml: entityXml, applicationRibbonXml: appXml, capturedAt: "2026-01-01T00:00:00Z",
  };
}

describe("hydrateRibbonLabels", () => {
  it("resolves custom labels and tooltips absent from a merged ribbon", () => {
    const loaded = workspace();
    const original = structuredClone(loaded);
    expect(loaded.ribbons.HomepageGrid.tabs[0].groups[0].buttons[0].label).toBe(LABEL);
    const hydrated = hydrateRibbonLabels(loaded, source());
    const tab = hydrated.ribbons.HomepageGrid.tabs[0];
    const group = tab.groups[0];
    const review = group.buttons[0];
    expect(tab.label).toBe("Sample Records");
    expect(group.label).toBe("Record Actions");
    expect(review.label).toBe("Review Record");
    expect(review.tooltipTitle).toBe("Review this record");
    expect(review.tooltipBody).toBe("Open the record review");
    expect(group.buttons[1].label).toBe("Ribbon.HomepageGrid.Save");
    expect(hydrated.ribbons.Application.tabs[0].groups[0].buttons[0].label).toBe("Application Command");
    expect(loaded).toEqual(original); // Pure: the loader's source model is unmodified.
  });

  it("retains English, Persian, other locales, sourceXml and entity-first translation precedence", () => {
    const hydrated = hydrateRibbonLabels(workspace(), source());
    const review = hydrated.locLabels.find(label => label.id === LABEL)!;
    expect(review.titles).toEqual([
      { languageCode: 1033, description: "Review Record" },
      { languageCode: 1065, description: "بررسی رکورد" },
      { languageCode: 1031, description: "Datensatz prüfen" },
    ]);
    expect(review.sourceXml).toContain('<LocLabel Id="Sample.Ribbon.Home.ReviewLabel">');
    expect(review.sourceXml).toContain('languagecode="1065"');
    const global = hydrated.locLabels.find(label => label.id === "Application.Only")!;
    expect(global.titles).toEqual([
      { languageCode: 1033, description: "Application Command" },
      { languageCode: 1065, description: "دستور عمومی" },
    ]);
    expect(global.sourceXml).toContain("Application.Only");
    expect(hydrated.locLabels.map(label => label.id)).toEqual([
      LABEL, "Sample.Tab.Title", "Sample.Group.Title", "Sample.Tooltip.Title", "Sample.Tooltip.Body", "Application.Only",
    ]);
  });

  it("keeps distinct merged platform labels and missing translations without overriding source precedence", () => {
    const input = workspace();
    const platform = { id: "Mscrm.PlatformSave", titles: [{ languageCode: 1033, description: "Save" }],
      sourceXml: '<LocLabel Id="Mscrm.PlatformSave"><Titles><Title languagecode="1033" description="Save"/></Titles></LocLabel>' };
    input.locLabels.push({ id: LABEL, titles: [
      { languageCode: 1033, description: "Stale merged label" },
      { languageCode: 1041, description: "レコードを確認" },
    ], sourceXml: '<LocLabel Id="Sample.Ribbon.Home.ReviewLabel" Origin="Merged"/>' }, platform);
    const hydrated = hydrateRibbonLabels(input, source());
    const primary = hydrated.locLabels.find(label => label.id === LABEL)!;
    expect(primary.titles).toEqual([
      { languageCode: 1033, description: "Review Record" },
      { languageCode: 1065, description: "بررسی رکورد" },
      { languageCode: 1031, description: "Datensatz prüfen" },
      { languageCode: 1041, description: "レコードを確認" },
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
