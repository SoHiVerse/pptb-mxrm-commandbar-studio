# Original CBS frontend, native Dynamics compatibility

The upstream CBS frontend remains the reference. The native HTML is a host
bootstrap, not a separate frontend: it initializes authenticated CRM APIs and
dynamically loads the same `src/main.tsx` and `src/App.tsx` as the PPTB entry.

## Source parity

The four ribbon-canvas modules (`ClassicRibbon`, `ModernCommandBar`,
`RibbonListView`, `RibbonCanvas`), shell `Layout`, global CSS, UI preferences,
properties sections, command editor, rule editor, command palette and the other
unchanged components are used directly. The native entry shares the original
canvas, renderer, layout, styling and editor component modules.

Seven component files have bounded compatibility changes:

| Component | Reason for the difference |
|---|---|
| TopBar | Original Save / Publish All appearance; connect the previously inert Save button to the existing dialog |
| BulkPublishModal | Original Fluent layout and controls; safe single-workspace publication is delegated to a controller, unavailable operations are gated, recovery can be downloaded |
| ImportXmlModal | Original dialog and Monaco layout; import into an undoable client-side draft rather than replacing the published baseline |
| XmlDrawer | Original four tabs, drawer, toolbar, formatting and completions; preview the preserved unmanaged definition, with an explicit inspect-only fallback |
| DiffViewer | Original full drawer, line statistics, theme and side-by-side/unified editor; compare preserved source against the actual target |
| FluentIcon | Keep the original icon map/frame; render validated same-organization `$webresource:` images instead of a generic fallback |
| IconPickerModal | Import-path change for the existing SVG conversion helper, separated for React fast-refresh lint compatibility |

The temporary extra canvas wrapper and blanket `inert` gates were removed from
App. RibbonCanvas again occupies the original flex-layout position alongside the
properties pane. A missing publication source is not a reason to disable browsing
or normal client-side editing.

## Data compatibility, not a redesigned UI

Dynamics 9.1 can export a standard entity as `<Name>Account</Name>` while its logical
root component is `account`; identity matching now accepts schema casing and still
rejects ambiguous duplicates. Its merged ribbon response may contain no LocLabel
declarations. The source-loading service supplies labels and translations from the
selected exported unmanaged source before capturing the baseline. Original label
and tooltip components can therefore show the supplied text without being rewritten.

Built-in `$Resources:` keys that are not supplied as localized label definitions
still use the upstream CBS fallback in `utils/displayLabel.ts`; no guessed
translations, fabricated icon mappings or copied replacement UI are introduced.

Native SubGrid tabs may be children of `ContextualGroup`, rather than direct
`Tabs` children. The data parser now includes both forms without treating
embedded customization declarations as rendered tabs. An unchanged preview
preserves the exact original XML and uses
matching comparison headings, avoiding a false change count. The installed
Monaco React wrapper's diff-model disposal order is handled without replacing
the original editor or drawer.

## Safety boundary

The frontend changes do not restore the unsafe per-location importer. Complete
unmanaged XML, publisher identity, preflight conflict checks, source/compiled
read-back, dirty-state preservation and recovery stay in the service/controller
layer. Explicitly unavailable server operations are disabled with an explanation,
not replaced by broader publication.

For reproducible local and deployed validation steps, see
`onpremises-verification.md`.
