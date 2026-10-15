# Native Dynamics 365 verification

## Candidate and source

Reference upstream commit: `27128373a3e4af32b81c07511191ada15192bc4f`.
Feature branch: `feat/onpremises-v91-native`.
Native application solution version: **1.0.1.1**.

The original CBS frontend is reused; the changes and source comparison are
documented in [frontend-fidelity.md](frontend-fidelity.md). The original canvas,
Classic/Modern/List renderers, shell layout, global CSS, UI preference store,
properties, command and rule editors remain the existing implementations.

## Local verification

| Check | Result |
|---|---|
| TypeScript (`npm run typecheck`) | Passed, exit 0 |
| ESLint (`npm run lint`) | Passed, zero lint warnings, exit 0 |
| Vitest (`npm test -- --maxWorkers=1`) | 427 passed in 33 files; no failed/skipped tests |
| Native packaging Node tests | 13 passed; no failed/skipped tests |
| Native production build | Passed, exit 0 |
| Original PPTB production build | Passed, exit 0 |
| Private read-only real Lead/Application source regressions | Passed, 3/3 |
| Independent read-only code review | No concrete P0/P1 release-blocking finding |

The full Vitest run had zero React `act` warnings. Four teardown messages came
from the installed Fluent/Tabster dependency tree carrying both Keyborg 2 and 3.
They were not suppressed and did not fail tests. Neither dependencies nor the
user's pre-existing untracked lockfile were changed to hide this behavior.

Vite reports the deliberately external CRM context script and large Monaco
chunks. The packaged HTML preserves the blocking context script before the module
entry; all emitted runtime assets are validated. These build warnings are not
missing assets or a CDN dependency.

## Installer

The native package contains **122 web resources**, with **15,360,422 bytes** of
uncompressed application assets. The largest resource, the TypeScript worker, is
**7,010,226 bytes**; deployment packaging used a verified 8 MiB per-file ceiling.
No organization upload-limit setting was changed.

The installation ZIP is **3,976,717 bytes**. SHA-256:

```text
042e26aa0a84af7e8a1f3efe7006b4c255b2f89b0c76db19df1383831b456adb
```

The local distributable is
`dist-onprem-package/CommandBarStudioNative_1_0_1_1_unmanaged.zip`, with a matching
`asset-manifest-1.0.1.1.json`. This particular package preserves the already
installed tool's publisher/solution identity; the CLI can produce a package for
another explicitly supplied identity. Do not reuse an unrelated organization's
publisher without checking its actual identifiers.

## Acceptance boundaries

The user authorized updating the application, followed by **read-only** checks in
solution `Ribbon`, entity `Lead`. No Lead customization import/publication or
business-record edits are part of this acceptance. ExportSolution is used only
to read the existing unmanaged definition and compare it before/after.

The local real-data checks verified the native `<Name>Lead</Name>` casing,
restored supplied custom labels/translations, parsed the contextual Lead SubGrid
tab, and confirmed an unchanged entity/application baseline yields no CustomAction
delta. They locally repackaged/read the same entity definition without changing
its XML and performed no CRM writes.

## Completed deployment and read-only browser acceptance

The application-only update to **1.0.1.1** was imported successfully: its import
job reported progress 100, 153 success results and zero failures. Only the tool's
122 web resources were then published. The server-side content hashes of all 122
resources matched the packaged manifest, and the published entry returned HTTP
200. A subsequent fresh check confirmed the installed solution version and the
same entry hash. No duplicate installation or new redesign was performed when
the interrupted session resumed.

The original CBS application was opened on **solution Ribbon / entity Lead**.
Read-only checks covered Classic, Modern and List views; Home Grid, contextual
Sub Grid, Form and Application locations; selecting an existing custom button;
its original properties and translations; command/rule inspection; the original
XML drawer; and side-by-side/unified comparison. The comparison showed **zero
added and zero removed lines** for the unchanged source. Repeated comparison
close/reopen and Escape dismissal produced no captured JavaScript errors.

The native source compatibility fixes resolved the existing custom labels,
including `Set Reminder`, and loaded all five web-resource images observed in the
selected view. At a 1920-pixel viewport the canvas occupied 1310 pixels alongside
the docked properties pane; it no longer overflowed to more than 13000 pixels.
No blanket inert gate remained. Final inspection showed **History (0), no Lead
draft, no attempted blocked write, and no open modal**. The application was left
on Lead's Modern command bar with Set Reminder selected and the command filter
cleared.

### Unchanged customization evidence

Before deployment and after read-only acceptance, the exported Lead source had
the same SHA-256 values:

```text
customizations.xml:
51cc5abd3d9421282c1161f8b79acf50db3de6785e727360c10069ca6cb0e96d

Lead RibbonDiffXml:
3bd6743ec17e4e2d0c553a63754eb1638fe7277f60d893c125131803e210f22c
```

The exported definition still contained 10 commands and 17 localized-label
definitions. The final source check was at `2026-10-15T08:08:24.576Z`; final
browser checks completed at `2026-10-15T08:16:27.167Z`. No Lead customization
import, entity publication, application-ribbon publication or business-record
write was executed as part of this acceptance.

### Performance observations and remaining upstream behavior

View changes and editor inspection reuse the loaded workspace. The restored
frontend keeps the original lazy-loaded panels, memoized views and virtualized
lists. Six observed click handlers took approximately **5–321 ms** in the attached
browser. Background-tab frame scheduling affected paint timings, so those
measurements are not a foreground performance benchmark. A read-only server
ExportSolution took **10.45 seconds**; server export time remains a loading cost,
not something hidden by a fabricated instant result.

Built-in platform `$Resources:` keys that CRM does not supply as label definitions
continue to use CBS's original fallback. They were not replaced with guessed
English text or a redesigned renderer. The supplied custom labels and actual CRM
resource images do resolve. The UI is the original CBS implementation, not a
new visual design or a claim that every upstream feature is bug-free.

Closing verification was rerun on the unchanged application commit `d61271d`:
427/427 Vitest tests, 13/13 packaging tests, TypeScript and ESLint passed. The
unsilenced run had zero React act warnings and the four known Keyborg teardown
messages described above. Private source XML, deployment receipts, hashes and
browser observations are retained locally under `.cbs-probe/reconciliation/`,
which is ignored by Git; they are not included in the distributable or PR.

The two implementation commits are `3578254` (native support with the original
frontend) and `d61271d` (contextual ribbon parsing, unchanged comparison and Monaco
lifecycle fixes). No remote push or upstream PR submission was performed. This
read-only acceptance is not certification of arbitrary business-ribbon writes.

Test-only browser API wrappers and timing observers were removed after acceptance
so the installed tool retains its normal host behavior. The owned temporary
deployment/evidence server was stopped. The original application tab remains open;
the installed application's resources were intentionally retained, not removed as
disposable test components. The pre-existing untracked lockfile was left unchanged.
