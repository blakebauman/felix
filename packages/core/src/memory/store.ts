/**
 * Vectorize-backed semantic memory store.
 *
 * On `remember(text)` we embed via Workers AI (`@cf/baai/bge-base-en-v1.5`,
 * 768 dims) and upsert into the `MEMORY_VEC` index with metadata
 * `{ tenant, manifest, ts, kind }`. On `recall(query, k)` we embed the
 * query and pull the top-k matches scoped to the caller's tenant.
 *
 * The index is provisioned in wrangler.jsonc. If a deploy hasn't created it
 * yet, calls degrade to no-op + log so a missing binding doesn't break the
 * agent loop.
 */

import { getContext } from '../context';
import type { Env } from '../env';

export interface MemoryRecord {
  id: string;
  text: string;
  tenant: string;
  manifest: string;
  kind: 'fact' | 'preference' | 'episode';
  ts: number;
}

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const DEFAULT_K = 5;

export interface MemoryStore {
  remember(text: string, kind?: MemoryRecord['kind']): Promise<MemoryRecord | null>;
  recall(query: string, k?: number): Promise<MemoryRecord[]>;
  forget(id: string): Promise<void>;
}

class VectorizeMemoryStore implements MemoryStore {
  constructor(
    private readonly env: Env,
    private readonly manifestId: string,
  ) {}

  private async embed(text: string): Promise<number[]> {
    const result = (await this.env.AI.run(
      EMBED_MODEL as keyof AiModels,
      {
        text,
      } as never,
    )) as unknown as { data: number[][] };
    return result.data?.[0] ?? [];
  }

  async remember(text: string, kind: MemoryRecord['kind'] = 'fact'): Promise<MemoryRecord | null> {
    try {
      const ctx = getContext();
      const tenant = ctx?.auth.principal.tenantId ?? 'default';
      const id = crypto.randomUUID();
      const values = await this.embed(text);
      if (values.length === 0) return null;
      await this.env.MEMORY_VEC.upsert([
        {
          id,
          values,
          metadata: { tenant, manifest: this.manifestId, kind, ts: Date.now(), text },
        },
      ]);
      return { id, text, tenant, manifest: this.manifestId, kind, ts: Date.now() };
    } catch (err) {
      console.warn('memory.remember failed', err);
      return null;
    }
  }

  async recall(query: string, k = DEFAULT_K): Promise<MemoryRecord[]> {
    try {
      const ctx = getContext();
      const tenant = ctx?.auth.principal.tenantId ?? 'default';
      const values = await this.embed(query);
      if (values.length === 0) return [];
      const matches = await this.env.MEMORY_VEC.query(values, {
        topK: k,
        returnMetadata: 'all',
        filter: { tenant },
      });
      return (matches.matches ?? []).map((m) => {
        const meta = (m.metadata ?? {}) as Record<string, unknown>;
        return {
          id: m.id,
          text: String(meta.text ?? ''),
          tenant: String(meta.tenant ?? tenant),
          manifest: String(meta.manifest ?? this.manifestId),
          kind: (meta.kind as MemoryRecord['kind']) ?? 'fact',
          ts: Number(meta.ts ?? 0),
        };
      });
    } catch (err) {
      console.warn('memory.recall failed', err);
      return [];
    }
  }

  async forget(id: string): Promise<void> {
    try {
      const ctx = getContext();
      const tenant = ctx?.auth.principal.tenantId ?? 'default';
      // Look up the vector by id and verify the caller's tenant owns it
      // before deleting. Without this check any tenant could pass an id
      // belonging to another tenant and erase their memory.
      const lookup = await this.env.MEMORY_VEC.getByIds([id]);
      const vec = lookup?.[0];
      if (!vec) return;
      const meta = (vec.metadata ?? {}) as Record<string, unknown>;
      if (String(meta.tenant ?? '') !== tenant) {
        console.warn(`memory.forget: refusing cross-tenant delete (id=${id})`);
        return;
      }
      await this.env.MEMORY_VEC.deleteByIds([id]);
    } catch (err) {
      console.warn('memory.forget failed', err);
    }
  }
}

class NoopMemoryStore implements MemoryStore {
  async remember(): Promise<null> {
    return null;
  }
  async recall(): Promise<MemoryRecord[]> {
    return [];
  }
  async forget(): Promise<void> {}
}

/** Resolve a memory store from the manifest's `spec.memory.store` value. */
export function getMemoryStore(env: Env, mode: string, manifestId: string): MemoryStore {
  // "agentcore" is a legacy alias kept for backward-compat with older
  // manifests; it resolves to the same Vectorize-backed store.
  if (mode === 'vectorize' || mode === 'agentcore') {
    return new VectorizeMemoryStore(env, manifestId);
  }
  return new NoopMemoryStore();
}
