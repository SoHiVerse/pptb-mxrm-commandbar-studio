# Native Dynamics 365 v9.1 hosting and safe ribbon publication

## Intent and scope

Implement the user's approved native-host approach as a reviewable feature in the existing Command Bar Studio repository. Run the same editor as HTML web resources inside Dynamics 365 Customer Engagement on-premises v9.1, using the signed-in CRM session, while preserving the existing PPTB entry and transport. Include the publishing correctness fixes established by the feasibility investigation; a write-enabled native host must not ship on the destructive existing publisher.

Work on `feat/onpremises-v91-native` in the supplied checkout. Preserve the pre-existing untracked lockfile and `.cbs-probe` evidence. No changes to business CRM components, server configuration, credential stores, or the PPTB desktop host. Live acceptance uses only uniquely identified disposable components and verifies their removal. Do not push or open a remote PR during implementation.

## Architecture

### Native entry and transport

`onprem.html` includes `ClientGlobalContext.js.aspx` synchronously, then loads `src/onprem.ts`. Native initialization validates the context organization URL and installs a typed, deliberately limited facade matching the methods this application uses. Only after initialization succeeds does the entry dynamically import `src/main.tsx`. This ordering is required by existing service module-level API captures.

The adapter calls `/api/data/v9.1` on the current organization's origin and path with browser session credentials. It does not implement MSAL, prompt for passwords, store tokens, bypass TLS, or require a proxy. URL validation applies equally to initial requests and server-supplied paging URLs. Singular logical entity names are resolved to actual entity-set names; metadata key requests retain single-object responses. OData strings, GUIDs and typed enum arguments have explicit encoders. Errors preserve useful CRM codes, reject HTML/login responses, and distinguish uncertain write outcomes from safe read retries.

Expose the nine used Dataverse methods and four host conveniences. Add a small runtime descriptor with host kind and verified capabilities, not a general provider framework. Probe the CSDL for optional operations; missing metadata never means permission to invoke a broader operation. Native `PublishAllXmlAsync` is unavailable unless positively detected. Read operations may retry a small number of transient failures; imports must never be blindly retried.

### Additive build and deployment

Keep PPTB `index.html` and its build contract intact. A separate Vite configuration produces `dist-onprem` with relative URLs and bundled/inlined static dependencies. Resource names use `<publisher-prefix>_/commandbarstudio/...`; the context-script path is calculated for the final HTML resource depth. Include all lazy modules, CSS, fonts and workers. No CDN or localhost dependency may remain in the deployed application.

Provide deterministic packaging into an unmanaged CRM solution ZIP plus an asset manifest. Stable component GUIDs derive from stable resource identity, never from build hashes or timestamps. The publisher/solution identity is configurable and validated. Packaging rejects unexpected extensions, path traversal, duplicate case-insensitive resource names and oversized files. A packaging dry run reports every resource, total size and largest resource. Deployment documentation covers the per-file organization upload limit, permissions, upgrade, rollback and removal; no global publish is implicitly required by a script.

### Separate merged runtime state from editable unmanaged XML

The merged ribbon is a display/baseline model, not the document to import. Preserve a `RibbonSourceSnapshot` from `ExportSolution` containing the selected solution's manifest and the target entity/application `RibbonDiffXml`. Capture the snapshot on workspace load before edits. Only unmanaged selected solutions are writable.

Store immutable baseline command/rule/label arrays in addition to baseline ribbons. Track actual structural edits, definition-only edits and labels, including undo/redo and draft restore. Draft restoration must retain the original baseline/source identity, never mark the restored edits as already published. Reject restoration against a conflicting server baseline instead of overwriting it.

Parse known definitions only from their definition containers, not command references. Retain raw XML on loaded controls/commands/rules so unknown attributes, nested menus and unsupported extensions are not destroyed by unrelated edits. Preserve action ordering. Unsupported authored action kinds must raise a validation error rather than silently vanish from serialization.

### Delta generation and preservation

Extend the existing generator with explicit baseline definitions and a structured `RibbonDelta` containing XML plus removal/unhide intent. Generate only intentional edits. An untouched Microsoft command with parsed JavaScript is not an intentional override. Command-only, rule-only, localized-label and reorder edits must be detected. Button movement updates sequence and parent placement. Removed/unhidden controls and tab rules require explicit removal intent rather than hoping an additive XML fragment removes them.

Merge generated deltas into the exported unmanaged XML, by exact identity, preserving all untouched nodes. Update a nested unmanaged control in place without discarding siblings or its enclosing custom action. Reject ambiguous duplicate declarations or unrepresentable edits with a useful error. Do not import a reconstructed copy of the entire merged Microsoft ribbon. Combine Home Grid, Sub Grid and entity Form edits into one complete entity definition; coordinate application changes in the same package when explicitly selected.

### Narrow solution package and publication

Clone the exported manifest, preserving the publisher subtree and solution identity. Update only the explicitly selected version. Create a ribbon-only customizations payload with the exported `<Name>` child convention and the complete intended ribbon. Declare only the affected entity shell (behavior 2) and explicitly requested application-ribbon roots. Do not reimport unrelated fields, forms, views, assemblies, web resources, or entire business-solution contents. Build a pre-change ribbon-only recovery package at the same time.

Before importing, re-export and compare the relevant unmanaged source with the loaded snapshot; abort on conflict. This is a conservative conflict check, not an atomic server-side lock. Serialize publication in the application and freeze/capture its input so later edits cannot be incorrectly marked published.

Perform a single import, inspect the actual import result and import-job error XML, then publish the requested scope. Never equate progress 100 or completed-on with success. Never broaden a failed targeted publish into publish-all. Application-ribbon publication uses its documented targeted node when supported; a genuinely required global operation must be explicit in the UI.

After publication, re-export the unmanaged ribbon and retrieve the merged ribbon. Verify persistence of the intended complete definition and relevant changed controls/commands before acknowledging success. Failure or timeout retains dirty state and the recovery package. Do not automatically import a rollback that could overwrite another user's work. A local package-download action is clearly distinguished from a server import/publish.

The supported Form location is the entity's form ribbon. The existing per-systemform selector must not imply support while reading only an entity baseline: implement a correct independent source/verification path or explicitly reject that unrepresentable scope before writing, with documented guidance to entity-level rules. Do not silently reroute it to the entity ribbon.

## Acceptance criteria

1. Native startup installs APIs before existing service modules load; PPTB startup still uses the host-provided APIs.
2. Transport tests cover organization path prefixes, paging, singular entity names, enum/string escaping, session errors, 204 writes, malformed responses, timeouts, and external-origin rejection.
3. Both builds complete and native output contains no absolute asset/CDN/localhost runtime dependency. The generated installable ZIP validates every resource mapping.
4. Existing tests plus desired-behavior regressions pass: command-only, rule-only, reorder and no unintended OOB command redefinition.
5. A+B edits across locations preserve earlier/unrelated customizations, raw unknown XML, and publisher option-value prefix 78123 in representative fixtures and disposable live acceptance.
6. Conflict, failed/uncertain import, failed publish and failed read-back never mark edits clean or trigger a broader write.
7. Draft restore, entity/solution switching and undo/redo preserve baselines and prevent cross-entity writes.
8. Deliver a clean local branch, installable native package, source/tests/docs, exact verification report, and verified cleanup of live acceptance components.

## Non-goals

No new Power Fx execution engine, PPTB desktop authentication provider, server plugin, external proxy, replacement ribbon designer, or broad reimplementation of platform command semantics. Full cross-version certification and arbitrary unsupported ribbon extensions are not claimed; unknown content is preserved or the edit fails closed.

## Primary references

- Microsoft on-premises customization support: https://learn.microsoft.com/en-us/dynamics365/customerengagement/on-premises/developer/customize-dev/when-edit-customization-file?view=op-9-1
- Export/edit/import ribbon workflow: https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/export-prepare-edit-import-ribbon
- Unmanaged-layer removal and preservation: https://learn.microsoft.com/en-us/troubleshoot/power-platform/power-apps/create-and-use-apps/remove-an-unmanaged-layer-for-ribbon
- Publish request schema: https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/publish-request-schema
- Vite 7 build options: https://v7.vite.dev/config/build-options

The local feasibility evidence is not committed because it contains organization-specific data. Sanitized fixtures and independently runnable tests replace it in the PR.
