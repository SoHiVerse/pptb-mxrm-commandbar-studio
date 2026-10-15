# SoHiVerse fork maintenance (not part of the upstream PR)

This `dev` branch belongs to the personal fork at
`SoHiVerse/pptb-mxrm-commandbar-studio`. Its upstream is
`mohsinonxrm/pptb-mxrm-commandbar-studio`, whose default branch is **dev**,
not `main`. This fork-only branch contains the sync workflow, read-only review
CI, and a dependency lockfile. None of those files should appear in the
upstream-targeted feature branch's diff or commits.

**PR #1 was merged into fork `dev` on 2026-10-15**. The fork's default
`dev` branch now contains BOTH the native Dynamics implementation and
fork-only maintenance. This is the branch users should update and build.
The older `feat/onpremises-v91-native` branch is optional historical
contribution history for a possible separate PR to the original author.
The scheduled workflow no longer depends on it or updates it.

## Automatic updates

`.github/workflows/fork-upstream-sync.yml` runs daily at **04:37 UTC** and
supports manual **Actions → Fork-only upstream synchronization → Run workflow**.
It performs one normal merge: **original `upstream/dev` into fork `dev`**.
This retains the already merged native support and fork-only maintenance
history. It does not rebase, reset, force-push, or change the old feature branch.

If upstream is already included, there is nothing to change. Otherwise the
workflow first checks the merge for conflicts and runs TypeScript, ESLint,
Vitest, package tests and BOTH production builds on the combined fork dev.
An upstream dependency-manifest change incompatible with the fork's pinned
`package-lock.json` intentionally stops the update until that lockfile is
reviewed. Once checks pass, a second upstream/fork fetch detects races,
then a normal, non-force fast-forward push advances fork `dev` only.

The fork's `GITHUB_TOKEN` is supplied to the final push only; no personal access
token, cloud credentials or workflow secrets are needed. Failures stop with no
force/reset/automatic conflict resolution. A conflict, GitHub workflow change,
dependency mismatch, failed test, missing permission or changed remote tip
requires human review in the failed Actions run.

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
manual run performs a **dry-run fast-forward push** with the scoped Actions
token, verifying permissions without changing `dev`.
You can also use the `Fork review
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
`origin` to your fork. To inspect a future upstream update manually before
updating the fork, use a temporary **integration branch from the fork dev**:

```sh
git fetch upstream dev
git fetch origin dev
git switch -c review-upstream-sync origin/dev
git merge upstream/dev
npm ci
npm run typecheck && npm run lint && npm test -- --maxWorkers=2
# Only after reviewing and verifying this integration:
git push origin HEAD:refs/heads/dev
```

On a merge conflict, resolve and verify deliberately before pushing; do not
silently select either side. If the local checkout has an old untracked
`package-lock.json`, back it up before switching into fork `dev`; this
file is TRACKED on the fork dev and must not be overwritten accidentally.

To contribute the on-prem feature to the upstream author later, start from
the separate clean `feat/onpremises-v91-native` branch and merge the latest
`upstream/dev` into it manually with tests. Do **not** use the fork dev branch
as the upstream PR source: it contains fork-specific workflows and lockfile.
