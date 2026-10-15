# Command Bar Studio — Changelog

All notable changes to Command Bar Studio will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- Separate native Dynamics 365 CE on-premises v9.1 HTML-web-resource entry,
  authenticated same-origin Web API facade, positive optional-capability detection,
  relative Vite build and deterministic installable solution packaging.
- Complete unmanaged ribbon preservation, pre-import conflict checks, narrow
  coherent imports, verified stored/compiled read-back and pre-change recovery ZIPs.
- Source-bound versioned drafts, per-user storage identity and protection against
  stale publication completion after reload. Unavailable source blocks publication,
  not the original client-side editor.

### Fixed

- Restored the upstream CBS canvas topology and original publish/import/XML/diff
  dialog layouts; safe operations remain behind the existing interface.
- Native exported entity schema casing (for example `Account` versus logical `account`), missing
  compiled LocLabels supplied from the original exported source, and authenticated
  CRM web-resource images rendered in the existing Fluent icon frame.
- Native contextual SubGrid tabs, no-edit comparisons that previously reported
  formatting/header changes, and orderly Monaco diff-model disposal on drawer close.

- Correct entity child-`Name` solution XML and preservation of the original
  publisher, including its option-value prefix.
- Command/rule-only changes, intentional ordering and visibility changes,
  unwanted OOB command redefinition, definition-reference parsing and action order.
- Preservation of nested/unknown XML during unrelated edits and complete
  replacement of intentionally edited command/rule definitions.
- Repeated-publish source-cache rebasing, later-edit dirty-state retention,
  undo/redo of definition edits and draft restoration without replacing the baseline.
- Safe XML import as an atomic editor mutation and complete unmanaged XML previews.
- Explicit test/build configuration and the lint configuration's undeclared
  `typescript-eslint` meta-package import, using the already declared parser/plugin.

### Safety and scope

- No implicit publish-all fallback or automatic retry/rollback of uncertain imports.
- Unsupported authored Power Fx/Custom API and per-systemform ribbon publication
  fail before writes; the entity-level Form ribbon remains supported.
- See `docs/onpremises-verification.md` for the reproducible validation checklist.

---

## [0.5.0] - 2026-07-16

### 🎉 First Beta Release

Command Bar Studio 0.5.0-beta — a fully featured visual designer for Dataverse
classic ribbon / command bar customizations, running inside Power Platform ToolBox.

#### ✨ Features

- **Visual ribbon canvas** — Classic (tabbed groups + large icon tiles), Modern
  (flat command bar), and List (data grid) views for all 4 ribbon locations
  (HomepageGrid, SubGrid, Form, Application)
- **Classic ribbon drag-and-drop** — Migrated from HTML5 native drag to **@dnd-kit**
  with a styled `DragOverlay` ghost tile (brand border, box-shadow, `grabbing` cursor).
  `DroppableSlot` zones between buttons show a 2 px animated drop-line indicator.
  `DroppableGroupContainer` highlights the target group. `PointerSensor` with 5 px
  activation constraint so ordinary clicks still select buttons. Keyboard sensor
  retained for accessibility.
- **Properties pane** — Label/tooltip/icon/kind/sequence/templateAlias editing;
  locale chip row; command binding; display/enable rule pills; scaling summary;
  advanced section (form scope, OpenRecordItem override, client-type filter)
- **Command editor** — JavaScript (library Browse… to Web Resource Browser), URL (PassParams,
  WinMode, named params), **Power Fx** (inline Monaco editor — syntax-highlighted,
  word wrap, no line numbers — with variable hints and async-rule note), Custom API;
  References tab with button breadcrumbs; Versions tab
- **Rule editor** — All 30 `RuleStep` kinds from `RibbonTypes.xsd`; drag-to-reorder;
  OrRule nesting with nested “Add step”; InvertResult + Default toggles;
  plain-English `summarizeRule()` output
- **Localization editor** — Multi-LCID label / tooltip title / tooltip body;
  20 built-in LCIDs; line-break insertion (`&#x200b;&#x200b;`)
- **Icon picker** — Fluent icons (auto-uploaded as SVG web resource), web resource
  browser, custom SVG upload
- **Scaling editor** — MaxSize / Scale step sequence management per MS docs
- **Tab display rules editor** — EntityRule (all 4 contexts) + PageRule
- **Web Resource Browser** — Virtualized; upload; edit JS/CSS/XML in Monaco;
  callback registry so selection propagates back to caller (Image16/32, library field)
- **URL Action Composer** — PassParams table, CrmParameter querystring keys, live preview
- **XML Drawer** — Per-location RibbonDiffXml in Monaco; Format XML; CBS completions
- **Diff / Compare Viewer** — Monaco `DiffEditor` baseline comparison
- **Bulk Publish dialog** — Per-entity change counts; progress overlay; ribbonmetadatasettoprocess monitoring
- **Solution Conflict Drawer** — `msdyn_componentlayer` provenance; managed-solution
  banner in properties pane auto-populated after ribbon load
- **Command Palette** (Ctrl+K) — buttons, commands, rules, entities, actions
- **Undo/Redo** — 80-entry history stack; `mutationsSincePublish` counter
- **localStorage persistence** — Auto-save + restore banner on startup

#### 🏗️ Architecture

- **Delta-only `RibbonDiffXml`** — only changed elements emitted; system `Mscrm.*`
  commands/rules never re-emitted; OOB commands with JS actions (e.g.
  `Mscrm.OpenRecordItem`) correctly emitted as overrides
- **Correct `behavior=2` (shell-only)** entity root component — does not drag in
  every attribute / form / view on import
- **ImportJobId required** — supplied to every `deploySolution` call; 5-minute poll
  with progress beats
- **Post-publish observability** — `ribbonmetadatasettoprocess` polling after
  `publishCustomizations()` surfaces silent ribbon-compile failures
- **Parser: all 30 rule kinds** — `EntityPrivilegeRule`, `RecordPrivilegeRule`,
  `ShowOnGridRule`, `DeviceTypeRule`, `RelationshipTypeRule`, and 14 more;
  previously these were silently dropped, risking security-rule corruption on republish
- **TabDisplayRules DOM scope** — read from document-level `RuleDefinitions > TabDisplayRules`,
  not from inside `<Tab>` elements (parser bug that caused tab rules to always appear empty)
- **Group selector fixed** — `:scope > Groups > Group` (dropped rogue `, Group` clause
  that matched groups inside `CustomAction > CommandUIDefinition`, creating phantom groups)
- **`getWebResourceContent` uses `api.retrieve`** instead of `queryData` with key
  predicate — correct single-record fetch that works reliably with PPTB's `dataverseAPI`
- **Web resource browser callback registry** — module-level one-shot callback
  so Image16/32 and Command Editor library-field Browse selections propagate correctly
  (previously selecting a resource in the browser did nothing — the `onSelect` prop
  was never wired through the global Layout overlay)
- **`@dnd-kit` DragOverlay** — ClassicRibbon button drag fully migrated from HTML5
  native drag to `@dnd-kit` (`useDraggable`, `useDroppable`, `DragOverlay`)
- **`@pptb/types` 1.2.3** — latest Power Platform ToolBox host API types

#### 🧪 Tests

- **148 / 148 passing** across 8 Vitest suites
- `all-rule-kinds.xml` fixture — covers every `RuleStep` kind in a round-trip
  parse → generate → re-parse test; regression guard for the 18 formerly-missing
  parser kinds, TabDisplayRules DOM scope, and group selector

---

## [0.1.0] - 2025-01-01

### Initial scaffold

- Project initialization with Vite + React 18 + TypeScript 5 + Fluent UI v9
- Shell layout, ribbon canvas stubs, Zustand stores, XML generator/parser scaffolding
