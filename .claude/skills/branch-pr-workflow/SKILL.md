---
name: branch-pr-workflow
description: Mandatory git workflow for Felix — every change lands via a feature branch and a pull request into main; direct commits to main are forbidden (hook-enforced).
when_to_use: 'Before committing ANY change; requests like "commit this", "ship this", "create a PR", "merge this"; when the block-main-commit hook fires; starting a new piece of work.'
---

# Branch + PR workflow

**Never commit to `main`.** Every change — code, docs, config, one-liners — lands through a
pull request. `main` is the deploy source and moves only by merging PRs on GitHub. A PreToolUse
hook (`.claude/hooks/block-main-commit.sh`) denies `git commit` / direct `git push` on main;
do not bypass it with detached HEADs or `--force` tricks.

**Never stack PRs.** Every PR branches from `main` and targets `main` — full stop. Do NOT branch
from another branch or open-PR, and do NOT use `gh pr create --base <non-main>`. If work seems to
"depend" on an unmerged PR, you have two correct options, in order of preference:

1. **Put it in one PR.** If the pieces genuinely can't be reviewed or shipped independently, they
   belong in the *same* branch/PR — don't split a single cohesive change into a chain.
2. **Wait for the parent to merge**, then branch the follow-up from fresh `main`. If the user
   hasn't merged the parent yet, say so and stop — do not work around it by stacking.

Rationale: stacked PRs force a merge order on the human reviewer, make each PR's diff misleading
(it shows the parent's changes too until the base merges), and turn one review into a fragile
chain. This repo's review *is* the oversight; keep every PR independently reviewable against `main`.
See also [.claude/rules/git-workflow.md](../../rules/git-workflow.md).

## Procedure

1. **Start from fresh main**
   ```bash
   git switch main && git pull --ff-only origin main
   git switch -c <type>/<short-slug>
   ```
   Branch types (match existing history): `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`.
   **Feature-based PRs:** the unit of a PR is a feature/area, not a single edit. Group all the
   related changes for one feature (or one audit area) into ONE branch/PR — do NOT open a
   separate PR per file or per individual fix. A larger body of related work lands as a *small
   number* of feature-scoped PRs, not dozens of tiny ones. Don't batch *unrelated* features
   together, and never stack. Reserve a one-fix PR for a genuinely isolated one-off change.

2. **Work + verify** on the branch: felix-dev-loop (`pnpm build` → `typecheck` → `test` → `lint`),
   docs-sync if API/schema surfaces changed. Commit messages follow the repo style
   (imperative subject, body explains why) and end with the Claude co-author line.

3. **Push + open the PR**
   ```bash
   git push -u origin <branch>
   gh pr create --title "<subject>" --body "<what/why, verification results>"
   ```
   PR body ends with: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

4. **CI must pass** (`gh pr checks --watch`). Fix failures on the branch; never merge red.

5. **Merging is the human gate.** Do NOT merge PRs yourself unless the user explicitly says to
   merge — this repo is AI-driven development with human oversight, and the PR review is the
   oversight. When asked to merge: `gh pr merge --merge` (merge commits, matching history).

6. **After merge**: `git switch main && git pull --ff-only`, delete the branch
   (`git branch -d <branch>`; `gh pr merge` with `--delete-branch` handles the remote).
   Deploys (`pnpm deploy:staging` / `deploy` / `docs:deploy`) run from updated main.

## Notes

- Emergency prod fixes take the same path — a small PR merges in minutes; the hook has no
  bypass by design.
- **No stacked PRs** (see the callout above): branch from `main`, target `main`, always.
  Dependent work goes in one PR or waits for the parent to merge — never a base-chain.
- The private-history archive branch (`backup/main-2026-07-11` on `felix-run-old`) is never
  merged or rebased into anything.
