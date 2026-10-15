# SoHiVerse fork maintenance (not part of the upstream PR)

This `dev` branch belongs to the personal fork at
`SoHiVerse/pptb-mxrm-commandbar-studio`. Its upstream is
`mohsinonxrm/pptb-mxrm-commandbar-studio`, whose default branch is **dev**,
not `main`. This fork-only branch contains the sync workflow, read-only review
CI, and a dependency lockfile. None of those files should appear in the
upstream-targeted feature branch's diff or commits.

The contribution branch is `feat/onpremises-v91-native`. A draft PR in the
personal fork proposes this branch into the fork's `dev`. Only after review
should a separate PR be submitted to the upstream repository's `dev`.

## Automatic updates

`.github/workflows/fork-upstream-sync.yml` runs daily at **04:37 UTC** and
supports manual **Actions → Fork-only upstream synchronization → Run workflow**.
It fetches upstream `dev` and prepares two different non-destructive merges:

1. `upstream/dev` into fork `dev` (retains fork-only maintenance files).
2. `upstream/dev` **directly** into `feat/onpremises-v91-native`, rather than
   pulling the fork's maintenance-only history into an upstream PR.

Before pushing an updated feature, the workflow checks the merge for conflicts
and runs TypeScript, ESLint, Vitest, package tests and both production builds.
It tests with this fork's pinned `package-lock.json` **without committing it
to the upstream-targeted feature branch**. An upstream dependency-manifest
change that disagrees with the fork's lockfile intentionally stops the update
until the lockfile is reviewed. The final push is atomic (both refs or neither),
non-force, and first checks that neither branch changed during verification.

The fork's `GITHUB_TOKEN` is supplied to the final push only; no personal access
token, cloud credentials or workflow secrets are needed. Failures stop with no
force/reset/automatic conflict resolution. A conflict, GitHub workflow change,
dependency mismatch, failed test, missing permission, changed remote tip or
unsupported atomic push requires human review in the failed Actions run.

GitHub does **not** trigger ordinary push-driven workflows for commits created
by its `GITHUB_TOKEN`. That is why this sync workflow performs checks **before**
its push; the separate fork PR workflow checks human-submitted changes.

The fork's PR checks also rerun on a PR metadata edit. This permits a fresh
check after a fork-only lockfile repair without polluting the upstream feature
branch with an empty commit or bringing fork-maintenance history into it.

## One-time Actions activation and inactivity caveat

On a newly created fork, enable GitHub Actions and explicitly enable the
scheduled workflow in the fork's **Actions** tab. After enabling, run it
manually once and confirm a green result. When upstream has not changed, a
manual run also performs a **dry-run atomic push** with the scoped Actions token
to verify that future automatic pushes will be authorized, without changing
either branch. You can also use the `Fork review
checks` workflow to test a pull request. Leave the repository's default
`GITHUB_TOKEN` read-only; each job specifies the narrow permissions it needs.

GitHub may **automatically disable scheduled workflows after 60 days of
public-repository inactivity** (even with a daily cron). This is a GitHub
platform limit, not an application bug. If upstream has no activity for a long
period, check Actions and re-enable the workflow when GitHub disables it; a
manual workflow_dispatch also allows an immediate catch-up after re-enabling.
Monitor failed Actions notifications. Schedule execution may be delayed.

## Manual recovery / later upstream submission

In the local Git checkout, `upstream` points to Mohsin's repository and
`origin` to your fork. Never force-push this contribution branch as part of
automated synchronization.

```sh
git fetch upstream dev
git fetch origin dev feat/onpremises-v91-native
git switch feat/onpremises-v91-native
git merge upstream/dev
npm ci                 # only if a matching local lockfile is available
npm run typecheck && npm run lint && npm test -- --maxWorkers=2
git push origin feat/onpremises-v91-native
```

On a merge conflict, resolve and verify deliberately before pushing; do not
silently select either side. To contribute upstream later, use the clean
`feat/onpremises-v91-native` head as the source and **target upstream `dev`**.
Keep the fork-only automation and lockfile out of that upstream PR.
