/**
 * Tool-name matching for governance targeting (policies, approvals, judges).
 *
 * Governance rules target tools by name — `policies[].tools`,
 * `approvals[].tools`, `judges[].target_tools`. For local tools the name is
 * fixed by the manifest author, but for MCP tools the name is
 * `${ref.name}__${remoteToolName}` where the REMOTE SERVER chooses the
 * `remoteToolName` half. With exact-name matching a malicious/compromised MCP
 * server could present a dangerous tool under a name the manifest's rules don't
 * list, dodging scope-gating and human approval.
 *
 * The fix is a manifest-controlled prefix glob: a trailing `*` matches any tool
 * whose name starts with the (manifest-chosen) prefix. So `stripe__*` gates
 * every tool from the `stripe` MCP server — the author controls `ref.name`, the
 * server can't escape the prefix by renaming. A bare `*` matches all tools.
 */

/** True when `toolName` matches a governance-target `pattern` (exact or trailing-`*` prefix). */
export function matchesToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return toolName.startsWith(pattern.slice(0, -1));
  return toolName === pattern;
}

/** True when `toolName` matches any pattern in the list. */
export function matchesAnyToolPattern(toolName: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesToolPattern(toolName, p));
}
