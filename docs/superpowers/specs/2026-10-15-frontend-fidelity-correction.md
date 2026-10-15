# CBS frontend fidelity correction

## Approved intent

Reuse the actual Command Bar Studio frontend, not a recreation. The original
checkout at `27128373a3e4af32b81c07511191ada15192bc4f` is the visual and interaction
baseline. Keep the native host/transport and proven XML preservation fixes behind
that frontend. Do not introduce a new design language, simplified dialogs, or an
on-premises-only replacement editor.

The user explicitly authorizes updating the installed application after local
verification and asks for read-only acceptance in solution **Ribbon**, entity
**Lead**. This does not authorize writing/importing/publishing Lead's ribbon or
changing records in that solution. Only the application's own web resources and
installer solution may be updated.

## Correction scope

- Restore upstream toolbar labels and XML/diff/import/publish dialog composition,
  retaining safe effect handlers and truthful publishing/recovery guidance.
- Preserve unchanged canvas, Classic/Modern/List views, command/rule/property
  editors, main layout, styling and pane controls.
- Remove the integration's extra canvas sizing/interaction gate. A source-export
  failure may block publication, not browsing and normal client-side editing.
- Fix the proven native export identity issue: exported standard entity `Name`
  uses schema casing (`Lead`), while its logical/root-component name is `lead`.
- Validate source/transport/build changes through focused regressions, full
  tests, both builds and the actual installed native package.
- Exercise the real browser UI, including layout bounds, readable supplied
  labels, ribbon views, selection, properties, command and rule dialogs, XML and
  diff drawers. Record any upstream behavior separately from integration defects.

## Boundaries

No broad frontend redesign. Do not restore the unsafe per-location importer or
blindly mark pending edits clean. No global publish, no Lead publish, no registry,
SQL, authentication or server configuration changes. No npm dependency changes or
replacement of the user's existing lockfile. No remote push.

## Completion

The local branch has a reviewed, tested commit; both builds succeed; the corrected
native application resources are published and verified; the app is left open on
Ribbon → Lead; acceptance evidence shows no customization writes to that solution
or entity. Local artifact paths, version/hash and any actual limitations are in
the handoff.
