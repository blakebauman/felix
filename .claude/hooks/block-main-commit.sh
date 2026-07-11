#!/bin/bash
# PreToolUse hook (Bash): enforce the branch-pr-workflow skill — no commits on
# main and no direct pushes to origin main. Work happens on feature branches
# and lands via PRs. Deny-only for the two operations; everything else passes.
cmd=$(jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0

case "$cmd" in
  *"git commit"*|*"git push"*) ;;
  *) exit 0;;
esac

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

deny() {
  jq -cn --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

case "$cmd" in
  *"git commit"*)
    [ "$branch" = "main" ] && deny "Committing on main is not allowed — every change lands via a PR (branch-pr-workflow skill). Create a branch first: git switch -c <type>/<slug>, then commit there and open a PR with gh pr create."
    ;;
esac

case "$cmd" in
  # Direct push to main in any spelling (git push origin main / main:main /
  # HEAD:main while on main). Pushing feature branches is fine.
  *"git push"*origin*" main"*|*"git push"*origin*":main"*)
    deny "Direct pushes to origin main are not allowed — main moves only by merging PRs on GitHub (branch-pr-workflow skill). Push your feature branch and gh pr create instead."
    ;;
  *"git push"*)
    # On main, a bare push (no refspec) defaults to pushing main. Pushes with
    # an explicit non-main refspec (e.g. a feature branch) are fine; explicit
    # main refspecs were already denied above.
    if [ "$branch" = "main" ]; then
      bare=$(printf '%s' "$cmd" | grep -oE "git push( -u| --force-with-lease| -f)*( origin)?[[:space:]]*$")
      [ -n "$bare" ] && deny "You are on main and this push has no refspec, so it would push main directly — not allowed (branch-pr-workflow skill). Branch first: git switch -c <type>/<slug>."
    fi
    ;;
esac
exit 0
