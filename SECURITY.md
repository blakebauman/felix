# Security Policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/blakebauman/felix/security/advisories/new) ("Report a vulnerability"). Do **not** open a public issue for anything exploitable.

You can expect an acknowledgement within a few days. Please include reproduction steps, the affected surface (route, package, or manifest field), and impact.

## Scope

Felix handles authentication, multi-tenant data isolation, and payments, so reports in these areas are especially valuable:

- **Tenant isolation** — any read or write that crosses a `tenant_id` boundary (D1 queries, Durable Object keying, R2 paths, Vectorize filters).
- **Auth** — JWT verification (`JWT_VERIFIERS`), scope enforcement (`requireScope`), the self-issued JWKS surface, outbound OAuth token caching.
- **Payments / commerce** — Stripe webhook verification, ACP endpoint auth (`ACP_API_KEY`), approval-gated checkout bypasses.
- **Governance bypasses** — ways to evade policy, limits, guardrail, judge, or approval wrappers on tool execution.
- **SSRF / injection** — outbound fetches from tools, MCP/A2A clients, or connectors escaping the SSRF allow-list.

## Supported versions

Felix is pre-1.0; only the latest state of `main` is supported. Fixes land on `main` and ship in the next tagged release.
