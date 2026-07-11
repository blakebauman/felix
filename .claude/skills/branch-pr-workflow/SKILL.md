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

## Procedure

1. **Start from fresh main**
   ```bash
   git switch main && git pull --ff-only origin main
   git switch -c <type>/<short-slug>
   ```
   Branch types (match existing history): `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`.
   One branch = one reviewable concern; don't batch unrelated changes.

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
- Stacked work: branch from the open PR's branch, note the dependency in the PR body, and
  retarget the base after the parent merges.
- The private-history archive branch (`backup/main-2026-07-11` on `felix-run-old`) is never
  merged or rebased into anything.
