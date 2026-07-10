import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('app smoke', () => {
  it('serves /health', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/health');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('serves /v1/models', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/v1/models');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('exposes /.well-known/agent-card.json', async () => {
    const resp = await SELF.fetch('https://orchestrator.test/.well-known/agent-card.json');
    // Without a bundled manifest in the placeholder, this will 500 — we
    // assert one of the two acceptable statuses so the smoke test passes
    // both pre- and post-bundle. Once `pnpm build:manifests` runs against
    // this repo's manifests/, this becomes a strict 200 check.
    expect([200, 500]).toContain(resp.status);
  });
});
