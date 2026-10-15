# Native Dynamics 365 CE v9.1 verification checklist

Use this checklist to verify the native HTML-web-resource build and the shared
Command Bar Studio editor. Record results for each deployment privately; do not
commit organization URLs, publisher/solution identities, source XML, business
record identifiers, import jobs, version receipts or exported source hashes.
See [onpremises.md](onpremises.md) for packaging, permissions, installation,
upgrade and recovery instructions. For source/UI parity, see
[frontend-fidelity.md](frontend-fidelity.md).

## Automated validation before deployment

Run from the repository root with its declared dependencies installed:

```powershell
npm run typecheck
npm run lint
npm test -- --maxWorkers=1
npm run test:package:onprem
npm run build
npm run build:onprem
```

All checks must exit successfully. Vitest covers transport, XML parsing and
preservation, publication conflicts/recovery, ribbon editing, drafts and shared
frontend behavior. Native packaging tests also validate the resource archive,
stable identities and unsafe input rejection. Keep the complete test output;
separately identify dependency teardown notices, Vite's external CRM context
script notice and Monaco chunk-size warnings rather than hiding them.

Check the built native assets and package without connecting to CRM:

```powershell
# Substitute the verified per-file limit of the target organization.
npm run package:onprem -- --max-file-bytes 8388608 --dry-run
npm run package:onprem -- --max-file-bytes 8388608
```

- Confirm the dry run lists every resource, its size and the largest file;
  never assume a compressed ZIP fits the uncompressed per-resource limit.
- Inspect `asset-manifest.json`: resource names and GUIDs must be unique,
  stable for unchanged logical names, and consistent with the chosen publisher.
- Confirm the unmanaged ZIP includes real `WebResources/` binary entries for
  every manifest reference, together with valid solution/customization metadata.
- Verify relative module/stylesheet paths, bundled worker assets and a blocking
  `ClientGlobalContext.js.aspx` before the native module entry. The deployed
  package must not require localhost, a CDN or an external auth proxy.
- Verify the original PPTB build still works independently of the native entry.

## Isolated CRM acceptance

Start in an isolated non-production organization using disposable test
components and an explicitly selected unmanaged solution. Retain private
before/after exports if the environment's change-control process requires them.

1. Verify the publisher unique name, prefix, option-value prefix, solution
   identity and version against the target; never borrow an unrelated identity.
2. Import the editor-only unmanaged package, inspect the actual import-job result
   and publish the imported web resources with a supported targeted operation.
   Record the result separately from package creation.
3. Inspect the installed HTML entry, module/chunk/CSS/worker requests and
   network responses. Confirm the signed-in CRM session and organization virtual
   path are used consistently, with no cross-origin or redirected login response.
4. Read a known entity's ribbon through the normal UI. Check Classic, Modern,
   List, Home Grid, SubGrid, Form and Application views and original properties,
   command/rule editors, import dialog, XML drawer and diff drawer. Missing source
   permissions must be explicit without blocking read-only inspection.
5. Check that a merged response without `LocLabels` gets custom text/translations
   from the exported unmanaged source; `$Resources:` keys without supplied labels
   keep the existing CBS fallback. Verify tabs nested in `ContextualGroup` and
   same-organization `$webresource:` images, including subdirectory names.
6. On an untouched workspace, compare exported ribbon XML and generated preview:
   the source must remain byte-for-byte unchanged, with no added/removed ribbon
   delta and no generated changes to unsupported XML. Confirm clean history and
   no unexpected server write requests after inspection.
7. If write acceptance is authorized, use disposable components to test
   command-only, rule-only, locale, reorder and explicit delete/unhide cases.
   Re-export the unmanaged ribbon and read back the compiled ribbon after a
   targeted publish. Confirm unrelated source nodes and publisher details are
   preserved and that the recovery package is downloadable.
8. Test a stale source/version conflict and an unavailable publish operation:
   both must fail before import without losing the pending draft. A failed or
   uncertain import/publish must leave the workspace dirty, and no targeted
   failure may fall back to a broad `PublishAllXmlAsync` operation.
9. Remove only owned disposable acceptance components, verify cleanup and
   preserve the editor deployment if it is meant to remain installed.

Record separately whether the tested environment allows live *ribbon writes*;
a successful editor installation or read-only inspection does not establish
write-side behavior in arbitrary solutions or other Dynamics versions.

## Evidence to capture per verification run

Use a private change-control record with the tested Git revision, CRM release,
environment class (development/test/production), command and test outcomes,
package resource count and size limit, import/publish status, browser/network
observations, source-comparison result and any remaining limitations. Never
copy production XML, job identifiers, resource hashes or screenshots containing
customer data into the upstream pull request.
