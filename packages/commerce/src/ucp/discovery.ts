/**
 * UCP discovery — the merchant profile at `/.well-known/ucp`.
 *
 * The entry point platforms fetch to learn this merchant speaks UCP: protocol
 * version, offered services + their REST endpoints (our `/ucp` mount, derived
 * from the request origin so every deployment self-describes), capabilities
 * (checkout + the fulfillment extension), and advertised payment handlers.
 * Public and unauthenticated like `robots.txt` — but 404s when `UCP_API_KEY`
 * is unset so a deployment without the surface enabled doesn't advertise it.
 *
 * Mounted at `/` in `plugin.ts` (root, where platforms look).
 */

import type { Env } from '@felix/harness/env';
import { Hono } from 'hono';
import { stripePaymentHandler } from './checkout';
import { UCP_VERSION } from './models';

const SPEC_BASE = `https://ucp.dev/${UCP_VERSION}`;

export function buildUcpDiscoveryProfile(origin: string) {
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        'dev.ucp.shopping': {
          version: UCP_VERSION,
          spec: `${SPEC_BASE}/specification/shopping`,
          rest: {
            schema: `${SPEC_BASE}/services/shopping/openapi.json`,
            endpoint: `${origin}/ucp`,
          },
        },
      },
      capabilities: [
        {
          name: 'dev.ucp.shopping.checkout',
          version: UCP_VERSION,
          spec: `${SPEC_BASE}/specification/shopping/checkout`,
          schema: `${SPEC_BASE}/schemas/shopping/checkout.json`,
        },
        {
          name: 'dev.ucp.shopping.fulfillment',
          version: UCP_VERSION,
          spec: `${SPEC_BASE}/specification/shopping/fulfillment`,
          schema: `${SPEC_BASE}/schemas/shopping/fulfillment.json`,
          extends: 'dev.ucp.shopping.checkout',
        },
      ],
    },
    payment: { handlers: [stripePaymentHandler()] },
  };
}

export function buildUcpDiscoveryRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/.well-known/ucp', (c) => {
    if (!c.env.UCP_API_KEY) return c.notFound();
    return c.json(buildUcpDiscoveryProfile(new URL(c.req.url).origin));
  });
  return app;
}
