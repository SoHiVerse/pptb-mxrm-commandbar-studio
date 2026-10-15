# Native Dynamics 365 CE on-premises v9.1 deployment

This deployment hosts Command Bar Studio directly as HTML, JavaScript and CSS
web resources in Dynamics 365 Customer Engagement **on-premises 9.1**. It uses
the current CRM user's browser session and the `/api/data/v9.1` Web API.
The native build is separate from the Power Platform ToolBox (PPTB) build.

## Requirements and limitations

- Access to an on-premises Dynamics 365 CE 9.1 organization and an **unmanaged**
  solution suitable for the standalone editor. Use an account with privileges
  to import solutions, manage web resources, customize and publish; System
  Administrator or an appropriately privileged System Customizer is typical.
- A publisher with a matching *unique name, customization prefix and option
  value prefix*. If the publisher/solution already exists, match its actual
  identities. The `mxrm` default is an example, not an instruction to reuse a
  publisher owned by someone else.
- Modern Chromium or other browser matching the Vite target (Chrome 108+,
  Firefox 115+ or Safari 16+). Embedded CRM security policies and the exact
  browser must permit loading module scripts and local Web Workers.
- A CRM web-resource upload size limit that accommodates **every emitted
  resource individually**. Dynamics 365 9.1 defaults to 5 MB per web resource;
  administrators can change this under **Settings → Administration → System
  Settings → Email → Set file size limit for attachments**. The CLI validates
  the uncompressed individual asset bytes against `--max-file-bytes` and fails
  if any file exceeds the chosen limit. Set the CLI limit to the organization's
  *verified* limit; ZIP compression does not circumvent the CRM limit.

This packaging step is local and offline. It neither authenticates to CRM nor
imports, publishes or changes CRM components. The browser adapter does not
require an external authentication service, proxy, MSAL setup, CDN or credential
storage. No server settings or production business components are modified by
building the package.

## Build and inspect the package

Run these commands from the repository root after installing the repository's
already declared npm dependencies:

```powershell
npm run build:onprem
npm run test:package:onprem
# The default 5 MB guard intentionally rejects the approximately 7 MB TypeScript worker.
# Use 8 MB only after verifying that the target organization accepts that size.
npm run package:onprem -- --max-file-bytes 8388608 --dry-run
npm run package:onprem -- --max-file-bytes 8388608
```

`build:onprem` uses `vite.onprem.config.ts`, writes `dist-onprem/`, and leaves
the existing `npm run build` PPTB contract intact. It emits relative URLs,
bundles lazy chunks and Monaco language workers, and inlines unsupported
binary font/asset types into supported CSS/JavaScript resources. There is no
external runtime CDN.

`package:onprem` reads `dist-onprem/` and writes:

| Output | Purpose |
| --- | --- |
| `dist-onprem-package/CommandBarStudioNative_unmanaged.zip` | Unmanaged CRM solution containing web resources and actual binary payloads |
| `dist-onprem-package/asset-manifest.json` | Audit of logical resource names, GUIDs, file sizes and SHA-256 hashes |

The dry run enumerates **every** logical resource, its CRM type and file size,
the total bytes, and the largest individual resource. It writes no output.
The archive contains `solution.xml`, `customizations.xml`,
`[Content_Types].xml`, and a `WebResources/` binary part for each declared
`<WebResource>` (no asset is represented only by a JSON manifest). An internal
package check confirms the XML references point to actual ZIP entries.

### Configuring the solution and publisher

For an existing or separately provisioned publisher, use its **actual**
Dataverse identities. Supply all four identity parameters consistently when
releasing to a real organization:

```powershell
node scripts/package-onprem.mjs `
  --publisher-unique-name mxrmcommandbarstudio `
  --publisher-display-name "Command Bar Studio" `
  --publisher-prefix mxrm `
  --option-value-prefix 10000 `
  --solution-unique-name CommandBarStudioNative `
  --solution-display-name "Command Bar Studio Native" `
  --version 1.0.0.0 `
  --max-file-bytes 5242880 `
  --dry-run
```

Omit `--dry-run` to generate the ZIP and JSON. Optional `--input`, `--output`
and `--manifest` override the paths. `--help` lists supported flags. The
publisher prefix must be 2–8 lowercase alphanumeric characters starting with
a letter; the option value prefix must be an integer between 10000 and 99999;
the solution version must contain four numeric components. The CLI rejects
case-insensitive logical-name collisions, `..` traversal, symlinks,
unexpected or unsupported resource extensions, absolute asset URLs, missing
referenced assets, and files over the specified limit.

Resource names always use:

```text
<publisher-prefix>_/commandbarstudio/onprem.html
<publisher-prefix>_/commandbarstudio/assets/<vite-generated-file>.js
<publisher-prefix>_/commandbarstudio/assets/<vite-generated-file>.css
```

The package derives stable RFC 4122 version-5 web-resource component GUIDs
from each logical name. In particular, the HTML entry keeps its GUID on
upgrades even when code content changes. Vite's content-hashed chunk filenames
may change between releases, which gives those *new* chunk names new GUIDs.
Keep the same publisher prefix and solution identity across upgrades.
As observed in an actual on-premises 9.1 export, ZIP binary entries flatten
the logical name's `/` and `.` characters and append an uppercase GUID; the
`<Name>` and `RootComponent schemaName` preserve the full logical name.

For an HTML resource at `mxrm_/commandbarstudio/onprem.html`, the synchronous
global context script is `../../ClientGlobalContext.js.aspx`, resolving to
`/WebResources/ClientGlobalContext.js.aspx` **relative to the current CRM
organization path**. That script must execute before the native host module.
The packager checks this ordering and rejects external or root-absolute
module/stylesheet paths. It does not package Microsoft's context script.

## Editing and publication boundaries

The editor keeps the merged ribbon for display and separately exports the selected
unmanaged solution as the authoritative customization source. Choose a small
ribbon-focused solution containing the required entity shells rather than a large
business solution. A failed source export prevents server publication but does not
disable the original canvas, properties or client-side editors. Inspect Console
for the source error and reload before publishing. Source-bound automatic drafts
require a verified source; keep unsourced edits in the open window or export XML.

Publishing constructs one complete, ribbon-only entity definition across Home
Grid, Sub Grid and entity Form locations, preserving the original publisher and
unrelated XML. It detects changed source/version/publisher before import, checks
positive import-job results, and verifies both exported and compiled read-back.
Download Package does not import, publish, or mark edits saved. Recovery packages
are retained on failure, but never automatically imported over newer work.

The Form location is the entity-level ribbon, not independent systemform XML.
Per-systemform publication and moving an existing control between entity and
Application scopes are rejected before writes; author a separately scoped control
and command instead. Application changes require explicit selection and an
Application Ribbon root component in the selected solution. Unavailable native
`PublishAllXmlAsync` remains disabled; targeted failures never trigger publish-all.

Automatic drafts are plaintext browser-local configuration, scoped to organization,
CRM user, solution and entity. They retain selected ribbon baselines but omit
unrelated exported solution data and publisher contact details. Use a trusted
browser profile. A stale baseline, solution version or publisher identity is not
silently restored. Download a conflicting draft for manual reconciliation.

## Install into a non-production organization first

1. Inspect `asset-manifest.json`, validate the publisher and solution identity
   against the target CRM environment, and keep a local copy of the ZIP/JSON.
   The standalone solution is intended to contain the editor's web resources,
   not the organization's business tables or forms.
2. In **Settings → Customizations → Solutions** (or the solution manager in
   your organization's Dynamics 365 UI), select **Import**. Choose the
   generated `_unmanaged.zip`, inspect dependencies/solution identity and
   complete the import. Verify the import job's actual success, not merely
   that an upload finished.
3. **Publish the imported web resources** using the CRM customization UI or a
   supported targeted `PublishXml` request naming their GUIDs from the asset
   manifest. Publishing is a separate administrative action; the packaging
   script performs no global publish. If using a UI operation that publishes
   all customizations, understand its broader organization scope before using
   it. Do not treat solution import as proof that all browser-visible assets
   have been published.
4. Open the HTML web resource at the organization's URL (the exact prefix and
   organization path depend on your deployment), for example:

   ```text
   https://<crm-host>/<organization>/WebResources/mxrm_/commandbarstudio/onprem.html
   ```

   Open it **within the signed-in CRM session**. Verify the HTML entry and
   lazy modules, CSS, Monaco editor and workers in DevTools. Confirm there are
   no missing assets, cross-origin calls, redirected login/HTML responses or
   unexpected server write operations.
5. Exercise read-only workspace loading and verify the selected unmanaged
   source before attempting ribbon changes. Live ribbon publication is
   controlled by the application and should be accepted against disposable
   components before use on real customizations.

Do not hardcode a `/WebResources/...` root path in code or bookmarks when a
deployment hosts several organizations: Dynamics may redirect that path to
the default organization. Use the active organization's full client URL.

## Upgrade

1. Preserve the previous ZIP and JSON plus any separately exported recovery
   solution for ribbon edits. Increment `--version` (for example `1.0.0.1`)
   and build/package again with **the identical** publisher prefix and
   solution/publisher unique names and option-value prefix.
2. Compare the new and old manifest. Existing logical names retain their
   GUIDs. Content-hashed module names may differ and are included as new
   web-resource components. Import the new unmanaged solution and publish
   the changed web resources.
3. Reload the editor without an old browser cache and verify every script,
   style and Worker request. Referenced old hashed assets must remain
   available until the new published entry and all active clients have
   stopped requesting them. Importing an unmanaged solution does **not**
   implicitly delete web resources that disappeared from a later manifest.
4. If old chunks are no longer referenced, delete them only after a solution
   dependency check and explicit administrator review. The manifest provides
   precise names for that assessment.

## Recovery and uninstall

To recover an editor deployment, reimport the **previous working** unmanaged
ZIP using the same identities, publish those resources and verify that the
previous HTML entry resolves its required assets. A restored HTML entry can
reference older hashed chunks; the rollback package includes those files.
Confirm users have refreshed before retiring newer/older chunks.

The application's *ribbon publishing* recovery export is a different artifact
from this editor deployment ZIP. Preserve the targeted pre-change ribbon
recovery package supplied by the application; do not attempt to recover a
ribbon change by rolling back only the editor's web resources. Reimporting
a recovery package may overwrite other administrators' newer edits, so
re-export/compare the relevant target solution before restoring it.

Removing an **unmanaged** solution container does not automatically delete
its web resources from the organization's unmanaged layer. For an actual
uninstall, first verify no site map/form/ribbon uses the editor resources,
then remove the web resources by the logical names in the asset manifests,
publish the changes and delete the empty solution container. Check dependencies
and existing consumers before deletion; leave shared components untouched.

## Validation status and format references

The archive layout implements the Dynamics XML export convention and
cross-validates the webresource entries in the ZIP. The standalone package
is intended for **on-premises v9.1** and does not imply certification for
other versions. A successful local build/package validation is not evidence
that a live organization has imported or executed the package. Record actual
import, publish and browser outcomes separately in
`docs/onpremises-verification.md` when acceptance is performed.

Primary sources used for the packaging format and deployment limits:

- [Microsoft: Create, export, or import an unmanaged solution (on-premises v9.1)](https://learn.microsoft.com/en-us/dynamics365/customerengagement/on-premises/developer/create-export-import-unmanaged-solution?view=op-9-1)
- [Microsoft: Web resources for Dynamics 365 CE (on-premises v9.1)](https://learn.microsoft.com/en-us/dynamics365/customerengagement/on-premises/developer/web-resources?view=op-9-1)
- [Microsoft: Create and edit web resources (on-premises v9.1), including the 5 MB default](https://learn.microsoft.com/en-us/dynamics365/customerengagement/on-premises/customize/create-edit-web-resources?view=op-9-1)
- [Microsoft: SolutionPackager ZIP/WebResources layout](https://learn.microsoft.com/en-us/dynamics365/customerengagement/on-premises/developer/compress-extract-solution-file-solutionpackager?view=op-9-1)
- [Microsoft: Example exported WebResource XML and GUID-suffixed `/WebResources/` filenames](https://github.com/microsoft/d365cc-fde/blob/main/tools/ai-disposition-codes/solution/customizations.xml)
- [Microsoft: Edit customizations XML with schema validation (on-premises 9.1)](https://learn.microsoft.com/en-us/dynamics365/customerengagement/on-premises/developer/customize-dev/edit-customizations-xml-file-schema-validation?view=op-9-1)

Microsoft warns that manually editing exported web-resource component
definitions in `customizations.xml` is outside the supported *manual XML
editing* scenarios. This packager constructs the recognized exported-format
web-resource entries and validates their references, but only an import test
against the target version establishes that this generated ZIP is accepted
in that organization. See the separate live verification record for the
actual result before distributing a package as field-tested.
