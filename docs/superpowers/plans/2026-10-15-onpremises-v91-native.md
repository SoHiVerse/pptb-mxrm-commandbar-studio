# Native Dynamics 365 v9.1 Implementation Plan

> Final implementation and local verification status is recorded in
> `docs/onpremises-verification.md`. The approved
> `2026-10-15-frontend-fidelity-correction.md` spec supersedes UI redesign and
> blanket read-only behavior. Final deployment acceptance is application-only
> installation followed by **read-only Ribbon → Lead** inspection; the earlier
> proposed live write matrix is not authorization to modify that business ribbon.

**Closed:** 2026-10-15. The native tool is installed at 1.0.1.1; all 122 resource
hashes matched, read-only Ribbon / Lead acceptance passed, and before/after source
hashes are identical. Closing verification: 427 Vitest tests, 13 package tests,
TypeScript and ESLint pass. Implementation commits are 3578254 and d61271d.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Checkboxes track verified outcomes, not merely files written.

**Goal:** Deliver additive native CRM hosting with safe, verified ribbon publication in the existing application.

**Architecture:** Install a native API facade before dynamically importing the unchanged PPTB entry. Keep merged display models separate from exported unmanaged XML, merge intentional edits into a complete ribbon, and perform one narrow import with conservative conflict detection and read-back verification.

**Tech Stack:** Existing TypeScript, React 18, Zustand 5, Vite 7, Vitest 3, fflate and browser DOM/XML APIs. Use installed dependencies where possible; preserve the user's untracked lockfile.

**Spec:** `docs/superpowers/specs/2026-10-15-onpremises-v91-native.md`

## Global Constraints

- Target Dynamics 365 CE on-premises v9.1 using same-origin authenticated HTML web resources.
- Preserve existing PPTB startup and transport; no server, TLS, CORS or credential changes.
- Do not modify business CRM components. Live acceptance uses tracked disposable identifiers and cleanup.
- Keep implementation on `feat/onpremises-v91-native`; do not push or open a remote PR.
- Preserve unknown XML and publisher metadata; fail before writing on unsupported/ambiguous scope.
- Do not count import-job terminality or HTTP success alone as verified publication.

## Review Focus

- Forged paging URLs or organization path loss must never send authenticated requests outside the active organization's API.
- Nested controls and raw unsupported XML must survive an unrelated edit without flattening or deletion.
- Switching solution/entity or restoring a draft must not redirect an old workspace's edits to a new target.
- Partial/uncertain writes must keep dirty state and a recovery package; never auto-retry imports or broaden publication.
- Built asset hashes may change across releases while stable CRM resource identity and package paths remain consistent.

---

### Task 1: Native transport and entry

**Files:** new `src/hosts/onpremHost.ts`, `src/hosts/runtime.ts`, `src/onprem.ts`, `onprem.html`; tests `src/__tests__/onpremHost.test.ts`, `src/__tests__/onpremBootstrap.test.ts`.

**Interfaces:** `createOnPremHost(options)` returns the application's used Dataverse/Toolbox API subset; `installOnPremHost()` initializes it from `GetGlobalContext`. `getRuntimeCapabilities()` returns `{ kind, publishAllXmlAsync }` with safe defaults. Existing services still consume the injected globals.

- [x] Write and run failing tests for same-origin/path enforcement, object versus collection queries, paging, logical-name mapping, typed enums, HTTP/session failures, write return IDs and bootstrap order.
- [x] Implement transport with injected fetch for tests, bounded read retry/deadlines and no blind write retry.
- [x] Implement native entry and visible bootstrap failure; prove existing PPTB globals are not overwritten.
- [x] Run focused tests and typecheck, then stage only task-owned files for the grouped commit.

### Task 2: Correct model baselines, parser and delta generator

**Files:** `src/types/ribbon.ts`, new `src/types/workspace.ts`, `src/services/xmlParser.ts`, `src/services/xmlGenerator.ts`, `src/store/ribbonStore.ts`, `src/hooks/useRibbonPersistence.ts`; dedicated parser/generator/store/persistence tests.

**Interfaces:** `RibbonDefinitions` contains commands/displayRules/enableRules/locLabels; `RibbonWorkspace` adds ribbons. `GeneratorInput` accepts `baselineDefinitions?: RibbonDefinitions`. `generateRibbonDelta(input): RibbonDelta` returns XML plus explicit removals/unhides. `summarizeRibbonDiff(current, baseline, definitions?, baselineDefinitions?)` includes definition-only changes. Store exposes `baselineDefinitions`, `sourceSnapshot`, and safe draft restoration.

- [x] Promote the four feasibility regressions into desired-behavior tests; prove they fail on the baseline.
- [x] Test rule-definition scoping, original action order, raw-XML preservation, unsupported authored actions and source-label handling.
- [x] Implement explicit change comparisons, sequence/placement handling, no implicit system-command override, and correct `<Entity><Name>` wrappers.
- [x] Test and implement immutable definition baselines, undo/redo, label dirty tracking, versioned draft restore and entity identity guards.
- [x] Run focused suites and the unchanged baseline suite; no weakening of assertions to hide a regression.

### Task 3: Preserve unmanaged XML and construct narrow packages

**Files:** new `src/services/ribbonMerge.ts`, `src/services/ribbonSolutionPackage.ts`, tests `src/__tests__/ribbonMerge.test.ts`, `src/__tests__/ribbonSolutionPackage.test.ts`.

**Interfaces:** `mergeRibbonDiffXml(originalXml, deltas): string`; `parseRibbonSolution(base64, solutionUniqueName, entityLogicalName): RibbonSourceSnapshot`; `buildRibbonSolutionPackage(snapshot, changes): { base64, backupBase64, entityRibbonXml?, applicationRibbonXml? }`; `canonicalizeXml(xml): string` for conservative relevant-source comparison.

- [x] Write failing fixture tests for A then B preservation, nested custom controls, unknown attributes/nodes, explicit removal/unhide and duplicate declaration rejection.
- [x] Implement identity-aware merging without discarding enclosing actions or siblings.
- [x] Write failing package tests for child-Name identity, preserved publisher subtree/prefix78123, correct shell-only/application roots, and absence of unrelated business components.
- [x] Implement bounded ZIP parsing and narrow forward/recovery package construction; preserve manifest identity/version unless explicitly changed.
- [x] Test malformed/managed/mismatched/traversal input and deterministic output, then run focused tests.

### Task 4: Wire safe publication into the actual UI

**Files:** `src/services/dataverse/publishService.ts`, new `src/services/dataverse/ribbonSourceService.ts`, `src/App.tsx`, `src/components/modals/BulkPublishModal.tsx`, affected XML preview/restore callers; orchestration and UI tests.

**Interfaces:** `fetchRibbonSource(solutionUniqueName, entityLogicalName): Promise<RibbonSourceSnapshot>`; `prepareRibbonPublish(input): Promise<PreparedRibbonPublish>`; `publishRibbonWorkspace(input, onProgress?): Promise<PublishedRibbonResult>`. Inputs include fixed solution/entity identity, source snapshot, current/baseline workspace, application-scope consent and requested version. Publication results include verified refreshed source and recovery data.

- [x] Write failing tests for one import across entity locations, conflict refusal before write, failed import XML, missing progress/error shapes, unavailable async publish, no global fallback, and read-back mismatch.
- [x] Load/export the unmanaged source alongside the merged workspace; gate writes while source identity is unresolved.
- [x] Implement single-package import, useful progress/error states, targeted publish, raw source and merged read-back verification, and recovery download.
- [x] Preserve the original UI while routing publication through the safe controller; require explicit application scope and distinguish package download from server publication.
- [x] Keep later edits dirty if state changes during a publish; prevent stale responses from resetting a new workspace.
- [x] Test restore/switch race conditions and unsupported per-systemform scope before writes.

### Task 5: Native build, package and deployment documentation

**Files:** new `vite.onprem.config.ts`, `scripts/package-onprem.mjs` and focused Node tests; `package.json`, `tsconfig.node.json`, `.gitignore`, `vitest.config.ts`, `docs/onpremises.md`.

**Interfaces:** `npm run build:onprem` emits `dist-onprem`; `npm run package:onprem` produces an installable unmanaged solution ZIP and manifest with validated configurable publisher identity. Normal `npm run build` remains PPTB.

- [x] Write failing packaging tests for stable identities, case/path collisions, unexpected files, context-script paths, resource limits and ZIP internal references.
- [x] Implement the separate relative build and deterministic package. Verify the actual CRM solution XML format from primary schemas or a disposable export before claiming importability.
- [x] Build both modes, inspect all assets, and run packaging tests/dry-run.
- [x] Document installation, update/removal, native session behavior, permissions, supported scopes, recovery, and the absence of external authentication/proxy requirements.

### Task 6: Review, live acceptance and final handoff

- [x] Repair the existing lint configuration's undeclared `typescript-eslint` import using existing parser/plugin packages, without weakening rules; report unrelated baseline issues separately if any.
- [x] Run full tests, typecheck, lint, both builds and package validation with exact counts and exit codes.
- [x] Obtain an independent whole-change review emphasizing the five review-focus risks and address confirmed findings with regression tests.
- [x] Complete the superseding approved live acceptance: deploy the application-only package, verify all 122 resource hashes, inspect the original frontend on Ribbon / Lead read-only, and confirm unchanged exported source hashes. The earlier write matrix was not executed on Lead and is not claimed as certified live coverage.
- [x] Remove test-only browser API wrappers and instrumentation, close/discontinue owned helper tabs and stop the owned local evidence server. Keep the installed application and its resources, as the user requested; leave the tool open on Ribbon / Lead.
- [x] Write `docs/onpremises-verification.md` and PR handoff; commit logical change groups, verify clean tracked Git state, and provide paths, hashes and accurately bounded live results.
