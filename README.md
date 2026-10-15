# Command Bar Studio for Power Platform ToolBox

A fully featured visual designer for Dataverse **classic ribbon / command bar
customizations** — the spiritual successor to [Ribbon Workbench](https://www.develop1.net/public/rwb/ribbonworkbench.aspx)
reimagined with React 18, Fluent UI v9, and live Dataverse integration via
[Power Platform ToolBox](https://www.powerplatformtoolbox.com/).

The same editor also has a **native Dynamics 365 CE on-premises v9.1** build,
hosted as CRM HTML web resources using the existing signed-in browser session.
See [native deployment and packaging](docs/onpremises.md) and
[verification checklist](docs/onpremises-verification.md). The PPTB entry remains
separate; native hosting does not change authentication in the PPTB desktop host.

![Version](https://img.shields.io/badge/version-0.5.3--beta.1-orange)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript)
![Fluent UI](https://img.shields.io/badge/Fluent%20UI-v9-0078D4?logo=microsoft)
![PPTB Types](https://img.shields.io/badge/%40pptb%2Ftypes-1.2.3-orange)
![License](https://img.shields.io/badge/license-AGPL--3.0--only-green)
![Tests](https://img.shields.io/badge/tests-Vitest%20%2B%20Node-blue)

> **Classic commands only.** CBS targets Dataverse `RibbonDiffXml` — the
> classic commanding system. It does not modify Power Fx / Modern Commanding
> defined in the Command Designer.

---

## ✨ Features

### 🎨 Visual Ribbon Canvas
- **Classic ribbon view** — faithful tabbed ribbon with groups, large icon tiles, and @dnd-kit drag-and-drop reorder with a styled `DragOverlay` ghost (brand border, shadow, `grabbing` cursor) and animated 2 px drop-line indicators between button slots
- **Modern command bar view** — flat command bar exactly as rendered in Unified Interface
- **List view** — sortable data grid of all buttons with inline visibility toggle
- All 4 ribbon locations: **Home Grid**, **Sub Grid**, **Form**, **Application**
- Tab drag-to-reorder, inline rename (double-click), `+ Add tab`
- Context menus on buttons and groups — hide/show, duplicate, move, rename, delete, override OOB

### 📋 Properties Pane
- Identity: label, translations (multi-LCID), tooltip, icon picker, image16/32, kind, sequence, template alias
- Command binding with action summary chips
- Display rules + Enable rules pill lists with inline add/remove
- Scaling summary with link to full editor
- Advanced: form ribbon scope selector, `Mscrm.OpenRecordItem` override toggle, client-type filter shortcuts
- Conflict banner — surfaces managed-solution provenance via solution-layer API

### ⚡ Command Editor
- JavaScript function: library (with Browse… to Web Resource Browser), function name, positional CrmParameter editor
- URL action: address, PassParams, WinMode, named CrmParameters with querystring key
- JavaScript and URL actions are supported for classic ribbon publication.
- Power Fx / Custom API model entries are not silently serialized as classic actions;
  unsupported authored action kinds are rejected before import.
- Enable rules + Display rules binding
- References tab showing exact buttons + tab/group breadcrumb
- Versions tab from history
- Security advisory: all command definitions are visible in browser source

### 📐 Rule Editor
- All 30 RuleStep kinds from `RibbonTypes.xsd` — Enable rules and Display rules
- Drag-to-reorder steps
- OrRule with nested "Add nested step"
- InvertResult + Default value toggles per step
- Plain-English `summarizeRule()` output
- CustomRule async note (Promise\<boolean\> on Unified Interface)

### 🔤 Localization Editor
- Multi-LCID label / tooltip title / tooltip body per button
- Locale chip row with active/inactive state
- "Insert line break" (`&#x200b;&#x200b;`)
- 20 built-in LCIDs; add any custom LCID by number

### 🖼️ Icon Picker
- **Fluent icons** tab — 85 icon catalogue with category filter + regular/filled variant; auto-uploads selected icon as SVG web resource
- **Web resources** tab — browseable list of SVG resources in the org with search
- **Custom upload** tab — drag-and-drop SVG → create web resource

### 🗂️ Scaling Editor
- MaxSize + Scale step sequence management
- Document-order-based scaling behavior per MS docs (order of `<Scale>` elements, not Sequence values)
- Validation: non-overlapping MaxSize/Scale ranges

### 🗃️ Tab Display Rules Editor
- `EntityRule` (all 4 contexts) + `PageRule`
- Info note: entity-scoped tabs can only use EntityRule; global tabs can use both

### 🌐 Web Resource Browser
- Virtualized list with type filter, custom-only toggle, search
- Upload new resource directly from the browser
- Edit JS/CSS/XML files in Monaco

### 🔗 URL Action Composer
- Base URL, PassParams (full 6-parameter table per MS docs), custom CrmParameters
- Live URL preview; `&` → `&amp;` escaping handled automatically
- WinMode: Navigate / Dialog / Popup

### 📊 XML Drawer + Diff Viewer
- Per-location RibbonDiffXml view in Monaco (read-only + editable import path)
- "Format XML" button
- Monaco `DiffEditor` compare-to-baseline
- CBS-specific completions: `$LocLabels:`, `$webresource:`, `Command=`, `ModernImage=`

### 🔄 Publish Pipeline
- Load the exported unmanaged ribbon separately from the merged display model;
  apply intentional deltas while preserving unrelated and unknown XML.
- One coherent ribbon-only solution ZIP for the selected workspace, with
  `behavior=2` entity shells and the original publisher metadata.
- Detect source/version/publisher conflicts before writing; inspect the actual
  import result rather than equating 100% progress with success.
- Targeted publication without a broad fallback, followed by unmanaged and
  compiled-ribbon read-back verification and a downloadable recovery package.
- Command-only/rule-only edits, supported reordering, and repeated publications
  retain independent baselines and refreshed verified XML caches.
- `Mscrm.OpenRecordItem` override support — emitted as a system-command override when the user defines a JS action on it

### 🧩 Solution Conflict Drawer
- Provenance detection via `msdyn_componentlayer` (falls back to namespace heuristic when unavailable)
- Banner in properties pane for managed-solution buttons
- Live solution-layer fetch in the drawer

### ⌨️ Keyboard Shortcuts + Command Palette
- `Ctrl+K` — Command Palette (search buttons, commands, rules, entities, actions)
- `Ctrl+Z/Y`, `Ctrl+Shift+Z` — Undo / Redo (80-entry stack)
- `Ctrl+D` — Duplicate selected button
- `Ctrl+S` — Open Bulk Publish
- `Delete/Backspace` — Delete button (with OOB confirm)
- `F2` — Inline rename tab / group
- Arrow keys — navigate buttons on canvas

### 💾 Persistence
- Versioned local drafts keyed by organization, signed-in CRM user, solution and entity.
- Drafts retain original ribbon baselines; stale source/version/publisher changes
  prevent blind restoration. Unrelated exported metadata is not stored in a draft.
- Pane widths, collapsed state, view mode all persisted

---

## 🖼️ Interface Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ TopBar: Solution picker │ Ctrl+K │ Undo/Redo │ Save │ Publish   │
│ SubHeader: Breadcrumb   │ N changes since publish │ Preview …   │
├──────────────────┬──────────────────────────────┬───────────────┤
│ Left Pane        │ Ribbon Canvas                │ Properties    │
│ • Tables         │ Location: Home/Sub/Form/App  │ • Identity    │
│   (solution      │ Tab strip (drag-reorder)     │ • Command     │
│   scope only)    │ View: Classic / Modern / List│ • Rules       │
│ • Solution       │ Groups + Buttons (DnD)       │ • Scaling     │
│   Elements       │                              │ • Advanced    │
│   – Buttons      │                              │               │
│   – Commands     │                              │               │
│   – Rules        │                              │               │
│   – Templates    │                              │               │
├──────────────────┴──────────────────────────────┴───────────────┤
│ Bottom Panel: Commands │ Display Rules │ Enable Rules │ History  │
│              │ Console (runtime + publish log)                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Getting Started

Command Bar Studio runs **inside [Power Platform ToolBox](https://www.powerplatformtoolbox.com/)**. It requires the PPTB host to be available — authentication and Dataverse connectivity are provided by the host.

Alternatively, build and install the [native CRM web-resource solution](docs/onpremises.md).
Both modes use the same editor and preservation-aware publishing pipeline.

1. Install Power Platform ToolBox
2. Connect to a Dataverse environment
3. Open Command Bar Studio from the tool list
4. Pick an unmanaged solution from the TopBar
5. Select a table from the left pane
6. Edit ribbon buttons visually; click **Publish** when done

---

## 🛠️ Development

### Setup

```bash
git clone https://github.com/mohsinonxrm/pptb-mxrm-commandbar-studio.git
cd pptb-mxrm-commandbar-studio
npm install
```

### Common scripts

```bash
# Vite dev server (standalone — no PPTB host; ribbon APIs not available)
npm run dev

# TypeScript-only check (fast)
npm run typecheck

# Production build
npm run build

# Separate native Dynamics 365 CE 9.1 build and package validation
npm run build:onprem
npm run test:package:onprem
# Inspect the actual organization upload limit before choosing --max-file-bytes.
npm run package:onprem -- --max-file-bytes 8388608 --dry-run

# Preview the production build locally
npm run preview

# Run tests
npm test

# Run tests with coverage
npm run test:coverage
```

### Standalone vs PPTB-embedded

CBS has two supported hosts:

- **Embedded in PPTB** — loads inside the PPTB iframe. The host injects
  `window.dataverseAPI` (typed) and `window.toolboxAPI`. All publish, load, and
  web-resource operations work against the active connection.
- **Native CRM web resources** — `onprem.html` loads the CRM context and installs
  a same-origin host adapter before dynamically importing the shared application.
  No proxy, MSAL application registration or stored credential is required.

`npm run dev` is a Vite development server, not a standalone authentication host.
Opening its default page outside PPTB without injected host APIs fails startup.
The native deployed entry must run in the authenticated CRM origin, not localhost.

---

## 📦 Tech Stack

| Technology | Version | Purpose |
|---|---|---|
| **React** | 18.3 | UI framework |
| **TypeScript** | 5.8 | Strict mode, discriminated unions throughout |
| **Vite** | 7 | Build tooling + HMR |
| **Fluent UI v9** | 9.62 | Microsoft design system (Drawer, Dialog, DataGrid, Combobox…) |
| **Monaco Editor** | 0.55 | XML / JS / diff editing across XmlDrawer, DiffViewer, Command Editor |
| **@dnd-kit** | 6.3 | Drag-to-reorder for tabs, ribbon buttons (DragOverlay ghost + DroppableSlot indicators), and rule steps |
| **@fluentui-contrib/react-data-grid-react-window** | 1.4 | Virtualized entity list + web resource browser |
| **Zustand** | 5 | Global state (ribbons, selection, UI, session) |
| **fflate** | 0.8 | ZIP compression for solution package + ribbon XML decompression |
| **@pptb/types** | 1.2.3 | Power Platform ToolBox host API types (`window.dataverseAPI`, `window.toolboxAPI`) |
| **Vitest** | 3 | Editor, transport, preservation, publication and UI regression tests |

---

## 📁 Project Layout

```
src/
  components/
    shell/               — TopBar, SubHeader, Layout (resizable 4-pane)
    ribbon-canvas/       — RibbonCanvas, ClassicRibbon, ModernCommandBar, RibbonListView
    properties-pane/     — PropertiesPane + 6 section components
    bottom-panel/        — BottomPanel (Commands / Rules / History / Console tabs)
    panels/              — CommandEditor, RuleEditor, ScalingEditor, TabDisplayRules,
                           ConflictDrawer, WebResourceBrowser, UrlComposer,
                           DiffViewer, XmlDrawer
    modals/              — BulkPublish, IconPicker, LocalizationEditor, NewButton/Group/Tab,
                           HideOobWarning, ImportXml, MoveToFlyout
    command-palette/     — CommandPalette (Ctrl+K)
    shared/              — MonacoEditor, FluentIcon, CrmParameterEditor,
                           RuleStepEditor, RuleStepPicker, ResizableHandle
  services/
    xmlGenerator.ts      — Delta-only RibbonDiffXml generator (all 30 rule kinds)
    xmlParser.ts         — Merged ribbon XML parser (all 30 rule kinds)
    xmlValidator.ts      — Pre-import validation with user-friendly messages
    dataverse/
      ribbonService.ts         — RetrieveEntityRibbon / RetrieveApplicationRibbon
      publishService.ts        — Solution ZIP packaging + import + ribbonmetadatasettoprocess poll
      ribbonProvenanceService.ts — msdyn_componentlayer solution-layer provenance
      conflictService.ts       — fetchConflictLayersForElement
      webResourceService.ts    — loadWebResources / loadWebResourceByName / loadWebResourceContent
  store/
    ribbonStore.ts       — Ribbon state, 80-entry undo/redo, mutationsSincePublish
    selectionStore.ts    — Selected location / tab / group / button
    uiStore.ts           — Modal open states, pane widths, view mode (persisted)
    sessionStore.ts      — Solutions, entities, connection, publisher prefix
    runtimeLogStore.ts   — Console tab entries
  utils/
    ruleEngine.ts        — summarizeRule() + evaluateRule() for all 30 kinds
    idGenerator.ts       — Publisher-prefixed unique ribbon IDs
    webResourceBrowserCallback.ts — Module-level callback registry for WRB selection
    ribbonProvenance.ts  — applyProvenanceToRibbons + heuristicOrigin
    monacoCompletions.ts — $LocLabels: / $webresource: / Command= completions
  types/
    ribbon.ts            — Full domain model: RibbonButton, RuleStep (30 kinds), …
  __tests__/             — Vitest unit and integration regression tests
  __fixtures__/          — ribbon/account-full.xml, all-rule-kinds.xml, ribbondiff/…
```

---

## 🤝 Contributing

Contributions are welcome! Please read the [Conventional Commits](https://www.conventionalcommits.org/) guide —
all commits must follow the format enforced by `commitlint`.

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit: `git commit -m 'feat(canvas): add drag overlay'`
4. Push: `git push origin feat/my-feature`
5. Open a Pull Request → `dev`

**Branch model:**
- `dev` — working branch; all PRs target this
- `main` — protected; only release-tagged merges

---

## 📋 Roadmap

- [x] ~~ClassicRibbon drag migration to `@dnd-kit` with `DragOverlay` ghost~~ ✅ shipped in 0.5.0
- [ ] `QueueUpdateRibbonClientMetadata` for targeted ribbon-only publish (vs. broad `publishCustomizations`)
- [ ] Power Fx LSP / language server integration
- [ ] Import error line highlighting in Monaco
- [ ] Accessibility audit — verify full WCAG 2.1 AA compliance against spec §28
- [ ] ClassicRibbon button drag: migrate from `useDraggable` to `useSortable` for live in-place reordering animation

---

## 📄 License

Licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0-only)](LICENSE). See `LICENSE` for details.

---

## 🙏 Acknowledgments

- **[Scott Durrow](https://www.develop1.net/)** — creator of [Ribbon Workbench](https://www.develop1.net/public/rwb/ribbonworkbench.aspx),
  the original community tool for Dataverse ribbon customization and the direct
  inspiration for Command Bar Studio. CBS exists to carry that work forward inside
  the Power Platform ToolBox ecosystem.
- **[Power Platform ToolBox](https://github.com/PowerPlatformToolBox/desktop-app)** — host platform providing authenticated Dataverse access
- **[Fluent UI](https://react.fluentui.dev/)** — Microsoft design system
- **[Monaco Editor](https://microsoft.github.io/monaco-editor/)** — VS Code editor component

---

Built with ❤️ for the Power Platform community
