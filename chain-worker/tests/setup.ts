import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';
import type { D1Migration } from '@cloudflare/vitest-plugin';
beforeEach(async () => {
  const e = env as unknown as {
    CHAIN_DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  };
  await e.CHAIN_DB.exec('DROP TABLE IF EXISTS history_pages; DROP TABLE IF EXISTS bindings; DROP TABLE IF EXISTS key_owners; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS runtime; DROP TABLE IF EXISTS d1_migrations;');
  await applyD1Migrations(e.CHAIN_DB, e.TEST_MIGRATIONS);
});
