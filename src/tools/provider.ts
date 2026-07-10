/**
 * ToolProvider — abstraction for resolving manifest tool ids into Tool
 * instances.
 *
 * The default `InMemoryToolProvider` stores factories so tools can be
 * lazily constructed once and cached. There is no module-level mutable
 * state — composition wires one provider at Worker startup and threads it
 * into every `buildAgent` / `createApp` call.
 */

import type { Tool } from './types';

export interface ToolProvider {
  /** Returns a tool by id, or throws when unknown. */
  get(name: string): Tool;
  /** Resolves a list of ids; duplicates are deduped, unknowns throw. */
  resolve(names: readonly string[]): Tool[];
  /** Enumerates known tool ids — used by /v1/models and tests. */
  list(): string[];
  /** True iff a factory is registered. */
  has(name: string): boolean;
}

type Factory = () => Tool;

export class InMemoryToolProvider implements ToolProvider {
  private readonly factories: Map<string, Factory>;
  private readonly cache = new Map<string, Tool>();

  constructor(factories: Record<string, Factory> = {}) {
    this.factories = new Map(Object.entries(factories));
  }

  register(name: string, factory: Factory): void {
    this.factories.set(name, factory);
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  get(name: string): Tool {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`Unknown tool: ${name}`);
    }
    const tool = factory();
    this.cache.set(name, tool);
    return tool;
  }

  resolve(names: readonly string[]): Tool[] {
    const seen = new Set<string>();
    const out: Tool[] = [];
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(this.get(name));
    }
    return out;
  }

  list(): string[] {
    return [...this.factories.keys()];
  }
}
