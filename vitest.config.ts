import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { configDefaults, defineConfig, defineProject } from 'vitest/config';

/**
 * Two test projects:
 *
 *   - `unit`     plain node pool. Covers packages/core/tests/unit/** and each
 *                package's tests/ dir (feature plugins) — pure logic,
 *                governance wrappers, manifest schema, fake DO stubs.
 *   - `workers`  miniflare/workerd pool. Covers packages/core/tests/integration/**.
 *                Bindings are configured explicitly so the bundled
 *                workerd doesn't choke on the wrapped AI binding from
 *                wrangler.jsonc.
 */
export default defineConfig({
  test: {
    projects: [
      defineProject({
        test: {
          name: 'unit',
          include: ['packages/*/tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'packages/core/tests/integration/**'],
          environment: 'node',
        },
      }),
      defineProject({
        plugins: [
          cloudflareTest({
            // `main` is required for `SELF.fetch` — the runner needs to know
            // where the worker entrypoint lives.
            main: './packages/core/src/index.ts',
            // We don't point at wrangler.jsonc here: the bundled workerd
            // doesn't support the wrapped AI binding our production config
            // declares. Tests bind D1 / KV / R2 / DOs explicitly and stub
            // the AI binding via a service worker.
            miniflare: {
              compatibilityDate: '2024-12-30',
              compatibilityFlags: ['nodejs_compat'],
              d1Databases: ['DB'],
              kvNamespaces: ['CACHE'],
              r2Buckets: ['BUNDLES'],
              queueProducers: { AUDIT_QUEUE: 'felix-audit', JOBS_QUEUE: 'felix-jobs' },
              queueConsumers: { 'felix-audit': { maxBatchSize: 50, maxBatchTimeout: 5 } },
              durableObjects: {
                CONVERSATION_DO: 'ConversationDO',
                A2A_TASK_DO: 'A2ATaskDO',
                APPROVALS_DO: 'ApprovalsDO',
                FEDERATION_DO: 'FederationDO',
              },
              bindings: {
                ENVIRONMENT: 'development',
                AI_GATEWAY_SLUG: 'felix-test',
                AI_GATEWAY_ACCOUNT_ID: '',
                DEFAULT_MODEL_ID: 'claude-sonnet-4',
                MODEL_ROUTES: JSON.stringify({
                  'claude-sonnet-4': { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
                }),
                JWT_VERIFIERS: '',
                CONSUMER_SHARED_SECRET: 'test-shared-secret',
                ACP_API_KEY: 'test-acp-key',
                ACP_MERCHANT_TENANT: 'default',
                JWKS_PUBLIC: '{"keys":[{"kid":"test-kid","kty":"RSA","use":"sig"}]}',
              },
            },
          }),
        ],
        test: {
          name: 'workers',
          include: ['packages/core/tests/integration/**/*.test.ts'],
        },
      }),
    ],
  },
});
