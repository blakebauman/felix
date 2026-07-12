---
paths:
  - "**/*"
---

# Git workflow rules

- **Never commit to `main`.** Every change lands via a `<type>/<slug>` branch and a PR into `main`
  (hook-enforced by `.claude/hooks/block-main-commit.sh`). Merging is the human gate — do not merge
  unless the user explicitly says to.
- **NEVER stack PRs.** Every PR branches from `main` and targets `main`. Do NOT branch from another
  branch/open-PR, and NEVER pass `gh pr create --base <non-main>`. There are no exceptions.
  - If work "depends" on an unmerged PR: put it in the **same** PR if the pieces aren't
    independently reviewable, OR **wait** for the parent PR to merge and then branch the follow-up
    from fresh `main`. If the parent isn't merged yet, say so and stop — do not stack as a workaround.
  - Why: stacked PRs impose a merge order on the reviewer, show misleading diffs (the child's diff
    includes the parent's changes until the base merges), and turn one review into a fragile chain.
- **Feature-based PRs — the unit of a PR is a feature/area, not a single edit.** Group related
  changes (all the fixes for one feature, subsystem, or audit area) into ONE branch/PR. Do NOT open
  a separate PR per file or per individual fix — a body of related work should land as a small
  number of feature-scoped PRs, not dozens of tiny ones. Still don't batch *unrelated* features
  together, and still never stack. Reserve a one-fix PR for a genuinely isolated one-off change.
  - Why: many tiny PRs are a heavy review burden and a merge-order/conflict headache when they
    touch shared files; a few cohesive feature PRs are far easier to review and merge.
- Full procedure + rationale: the **branch-pr-workflow** skill (`.claude/skills/branch-pr-workflow/`).
