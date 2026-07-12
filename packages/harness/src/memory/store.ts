/**
 * pgvector-backed semantic memory store.
 *
 * On `remember(text)` we embed via Workers AI (`@cf/baai/bge-base-en-v1.5`,
 * 768 dims) and upsert into the `memory_vectors` table scoped by
 * (tenant, manifest, kind). On `recall(query, k)` we embed the query and
 * pull the top-k matches scoped to the caller's tenant AND the calling
 * agent's manifest (per-agent memory isolation) across the memory kinds
 * only — procedural and product vectors share the table but are excluded
 * by the explicit kind filter.
 *
 * If the Hyperdrive binding isn't wired, calls degrade to no-op + log so a
 * missing binding doesn't break the agent loop.
 */

import { getContext } from '../context';
import { deleteVector, queryVectors, upsertVector } from '../db/vectors';
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
const MEMORY_KINDS = ['fact', 'preference', 'episode'] as const;

export interface MemoryStore {
  remember(text: string, kind?: MemoryRecord['kind']): Promise<MemoryRecord | null>;
  recall(query: string, k?: number): Promise<MemoryRecord[]>;
  forget(id: string): Promise<void>;
}

class PgMemoryStore implements MemoryStore {
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
      if (!this.env.HYPERDRIVE) return null;
      const ctx = getContext();
      const tenant = ctx?.auth.principal.tenantId ?? 'default';
      const id = crypto.randomUUID();
      const values = await this.embed(text);
      if (values.length === 0) return null;
      const ts = Date.now();
      await upsertVector(this.env, {
        tenantId: tenant,
        id,
        kind,
        manifestId: this.manifestId,
        values,
        metadata: { text, ts },
      });
      return { id, text, tenant, manifest: this.manifestId, kind, ts };
    } catch (err) {
      console.warn('memory.remember failed', err);
      return null;
    }
  }

  async recall(query: string, k = DEFAULT_K): Promise<MemoryRecord[]> {
    try {
      if (!this.env.HYPERDRIVE) return [];
      const ctx = getContext();
      const tenant = ctx?.auth.principal.tenantId ?? 'default';
      const values = await this.embed(query);
      if (values.length === 0) return [];
      // Scope recall to the calling agent's own memory pool. Without the
      // manifest filter, two manifests under the same tenant would share a
      // semantic-memory pool (an internal agent's facts recallable by a
      // public-facing agent of the same tenant). Tenant isolation holds
      // regardless; the kind list keeps procedural/product vectors out.
      const matches = await queryVectors(this.env, {
        tenantId: tenant,
        kinds: MEMORY_KINDS,
        manifestId: this.manifestId,
        values,
        topK: k,
      });
      return matches.map((m) => ({
        id: m.id,
        text: String(m.metadata.text ?? ''),
        tenant,
        manifest: m.manifest_id || this.manifestId,
        kind: (m.kind as MemoryRecord['kind']) ?? 'fact',
        ts: Number(m.metadata.ts ?? m.created_at ?? 0),
      }));
    } catch (err) {
      console.warn('memory.recall failed', err);
      return [];
    }
  }

  async forget(id: string): Promise<void> {
    try {
      if (!this.env.HYPERDRIVE) return;
      const ctx = getContext();
      const tenant = ctx?.auth.principal.tenantId ?? 'default';
      // The tenant-scoped WHERE is the cross-tenant guard: an id belonging
      // to another tenant simply deletes nothing.
      await deleteVector(this.env, tenant, id);
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
  // "vectorize" keeps its manifest-enum name for backward compatibility but
  // resolves to the pgvector-backed store; "agentcore" is the older legacy
  // alias for the same thing.
  if (mode === 'vectorize' || mode === 'agentcore') {
    return new PgMemoryStore(env, manifestId);
  }
  return new NoopMemoryStore();
}
