/**
 * A2ATaskDO — Durable Object holding the lifecycle of a single A2A task.
 *
 * Cross-tenant isolation is structural: the DO id is derived from
 * `tenant#task`, so a lookup that doesn't include the tenant cannot
 * fabricate a stub for a task owned by another tenant.
 */

import type { Env } from '../env';

interface TaskState {
  taskId: string;
  tenantId: string;
  manifestName: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'failed';
  createdAt: number;
  updatedAt: number;
  output?: { messages?: Array<{ role: string; content: string }> };
  error?: string;
}

export class A2ATaskDO {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case '/init':
        return this.init(req);
      case '/get':
        return this.get();
      case '/complete':
        return this.complete(req);
      case '/cancel':
        return this.cancel();
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private async init(req: Request): Promise<Response> {
    const body = (await req.json()) as { taskId: string; tenantId: string; manifestName: string };
    const now = Date.now();
    const stored: TaskState = {
      taskId: body.taskId,
      tenantId: body.tenantId,
      manifestName: body.manifestName,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    };
    await this.state.storage.put('state', stored);
    return Response.json(stored);
  }

  private async get(): Promise<Response> {
    const stored = await this.state.storage.get<TaskState>('state');
    if (!stored) return new Response('not found', { status: 404 });
    return Response.json(stored);
  }

  private async complete(req: Request): Promise<Response> {
    const body = (await req.json()) as {
      status: TaskState['status'];
      output?: TaskState['output'];
      error?: string;
    };
    const stored = await this.state.blockConcurrencyWhile(async () => {
      const current = (await this.state.storage.get<TaskState>('state')) ?? null;
      if (!current) return null;
      current.status = body.status;
      current.output = body.output;
      current.error = body.error;
      current.updatedAt = Date.now();
      await this.state.storage.put('state', current);
      return current;
    });
    if (!stored) return new Response('not found', { status: 404 });
    return Response.json(stored);
  }

  private async cancel(): Promise<Response> {
    const stored = await this.state.blockConcurrencyWhile(async () => {
      const current = (await this.state.storage.get<TaskState>('state')) ?? null;
      if (!current) return null;
      current.status = 'cancelled';
      current.updatedAt = Date.now();
      await this.state.storage.put('state', current);
      return current;
    });
    if (!stored) return new Response('not found', { status: 404 });
    return Response.json(stored);
  }
}

export function taskDoStub(env: Env, tenantId: string, taskId: string): DurableObjectStub {
  const id = env.A2A_TASK_DO.idFromName(`${tenantId}#${taskId}`);
  return env.A2A_TASK_DO.get(id);
}
