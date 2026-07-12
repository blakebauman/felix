/**
 * Vitest globalSetup for the `workers` project — runs in Node (not workerd)
 * before any test file.
 *
 * Owns the test database schema: waits for Postgres (Docker locally via
 * `pnpm db:up`, a service container in CI), creates the `felix_test`
 * database if the volume predates docker/pg-init, drops + recreates the
 * `public` schema, and applies apps/api/migrations-pg with node-pg-migrate.
 * Test files therefore always see a fresh, fully-migrated schema and isolate
 * from each other by distinct tenant ids — never by truncating tables.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import pg from 'pg';

const DEFAULT_URL = 'postgresql://postgres:postgres@localhost:5432/felix_test';
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations-pg');

const CONNECT_ATTEMPTS = 30;
const CONNECT_DELAY_MS = 1000;

async function tryConnect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Connect with retries; creates the database if the server lacks it. */
async function connectToTestDb(url: string): Promise<pg.Client> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
    try {
      return await tryConnect(url);
    } catch (err) {
      lastError = err;
      // 3D000 invalid_catalog_name — server is up but the DB doesn't exist
      // (a docker volume that predates docker/pg-init). Create it via the
      // maintenance database and retry.
      if ((err as { code?: string }).code === '3D000') {
        const admin = new URL(url);
        admin.pathname = '/postgres';
        const dbName = new URL(url).pathname.slice(1);
        const client = await tryConnect(admin.toString());
        await client.query(`CREATE DATABASE "${dbName}"`);
        await client.end();
        continue;
      }
      await new Promise((r) => setTimeout(r, CONNECT_DELAY_MS));
    }
  }
  throw new Error(
    `global-setup: Postgres not reachable at ${url} after ${CONNECT_ATTEMPTS} attempts — ` +
      `run \`pnpm db:up\` (or set TEST_DATABASE_URL). Last error: ${lastError}`,
  );
}

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_URL;
  const client = await connectToTestDb(url);
  try {
    // Full reset: drops tables, extensions, and the pgmigrations bookkeeping
    // table so the baseline re-applies from scratch every run.
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
  await runner({
    databaseUrl: url,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  });
}
