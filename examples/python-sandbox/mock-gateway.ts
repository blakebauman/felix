/**
 * Mock gateway for the python-sandbox example. Implements the contract
 * Felix's `ContainerExecutor` expects so you can drive the manifest
 * end-to-end without standing up an actual container.
 *
 * Real deployment: replace this with a Worker that translates the same
 * POST body into a `getContainer(env.PYTHON_SANDBOX).fetch(...)` call.
 *
 * Run locally:
 *   pnpm dlx wrangler dev examples/python-sandbox/mock-gateway.ts --port 8788
 */

interface RunRequest {
  image: string;
  tool: string;
  arguments: { code?: string };
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/run') return new Response('not found', { status: 404 });
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

    let body: RunRequest;
    try {
      body = (await req.json()) as RunRequest;
    } catch {
      return new Response('bad request', { status: 400 });
    }

    if (body.tool !== 'python_runner') {
      return Response.json({ exit_code: 2, stderr: `unknown tool: ${body.tool}` });
    }

    const code = body.arguments.code ?? '';
    if (!code.trim()) {
      return Response.json({ exit_code: 1, stderr: 'no code supplied' });
    }

    // The real container would exec the snippet. The mock just echoes a
    // canned reply that mentions the snippet length, so end-to-end
    // testing has something deterministic to assert on.
    return Response.json({
      content: `[mock] would have run ${code.length} bytes of Python from image ${body.image}\n` +
        `[mock] sample stdout: ${code.split('\n')[0]?.slice(0, 80) ?? ''}\n`,
    });
  },
};
