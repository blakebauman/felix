/**
 * Integration-test setup helpers — apply the D1 schema to miniflare's
 * in-memory database so route handlers backed by D1 (audit / plans / jobs /
 * approvals / skill_activation) can be exercised end-to-end. Call
 * `await applyMigrations(env.DB)` from a `beforeAll` block.
 *
 * The SQL is imported as a string via Vite's `?raw` suffix so the file is
 * inlined at bundle time — workerd has no filesystem in tests.
 */

// @ts-expect-error — vite's ?raw imports are typed by `vite/client` which we
// don't pull in for tests; the type is `string`.
import initSql from '../../migrations/0001_init.sql?raw';
// @ts-expect-error — see above.
import hardenSql from '../../migrations/0002_harden.sql?raw';
// @ts-expect-error — see above.
import manifestsSql from '../../migrations/0003_manifests.sql?raw';
// @ts-expect-error — see above.
import evalSql from '../../migrations/0004_eval.sql?raw';
// @ts-expect-error — see above.
import canarySql from '../../migrations/0005_manifest_canary.sql?raw';
// @ts-expect-error — see above.
import commerceSql from '../../migrations/0006_commerce.sql?raw';
// @ts-expect-error — see above.
import acpSql from '../../migrations/0007_acp.sql?raw';
// @ts-expect-error — see above.
import brandsSql from '../../migrations/0008_brands.sql?raw';
// @ts-expect-error — see above.
import brandDomainsSql from '../../migrations/0009_brand_domains.sql?raw';
// @ts-expect-error — see above.
import dataSourcesSql from '../../migrations/0010_data_sources.sql?raw';
// @ts-expect-error — see above.
import b2bSql from '../../migrations/0011_b2b.sql?raw';
// @ts-expect-error — see above.
import quotesSql from '../../migrations/0012_quotes.sql?raw';
// @ts-expect-error — see above.
import contractPricingSql from '../../migrations/0013_contract_pricing.sql?raw';
// @ts-expect-error — see above.
import billingSql from '../../migrations/0014_billing.sql?raw';
// @ts-expect-error — see above.
import geoSql from '../../migrations/0015_geo.sql?raw';
// @ts-expect-error — see above.
import consentSql from '../../migrations/0016_consent_attribution.sql?raw';
// @ts-expect-error — see above.
import personalizationSql from '../../migrations/0017_personalization.sql?raw';
// @ts-expect-error — see above.
import dynamicPricingSql from '../../migrations/0018_dynamic_pricing.sql?raw';
// @ts-expect-error — see above.
import approvalsTtlSql from '../../migrations/0019_approvals_ttl.sql?raw';
// @ts-expect-error — see above.
import evalGateSql from '../../migrations/0022_eval_gate.sql?raw';

let cached: string[] | null = null;

function loadStatements(): string[] {
  if (cached) return cached;
  const combined = `${initSql as string}\n${hardenSql as string}\n${manifestsSql as string}\n${evalSql as string}\n${canarySql as string}\n${commerceSql as string}\n${acpSql as string}\n${brandsSql as string}\n${brandDomainsSql as string}\n${dataSourcesSql as string}\n${b2bSql as string}\n${quotesSql as string}\n${contractPricingSql as string}\n${billingSql as string}\n${geoSql as string}\n${consentSql as string}\n${personalizationSql as string}\n${dynamicPricingSql as string}\n${approvalsTtlSql as string}\n${evalGateSql as string}`;
  const stripped = combined.replace(/--.*$/gm, '');
  cached = stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return cached;
}

export async function applyMigrations(db: D1Database): Promise<void> {
  for (const stmt of loadStatements()) {
    await db.prepare(stmt).run();
  }
}
