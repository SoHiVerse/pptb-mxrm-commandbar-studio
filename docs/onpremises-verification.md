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

Post-deployment installation, browser checks and before/after hashes are recorded
below when their direct verification finishes. This is not a claim that the
current version has been live-tested for arbitrary business-ribbon writes.
