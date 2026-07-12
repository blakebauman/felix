-- Runs once on first container init (docker-entrypoint-initdb.d).
-- The vitest workers project uses its own database so globalSetup's
-- DROP SCHEMA ... CASCADE can never touch dev data in `felix`.
-- (The test globalSetup also creates this database on demand for
-- volumes that predate this init script.)
CREATE DATABASE felix_test;
