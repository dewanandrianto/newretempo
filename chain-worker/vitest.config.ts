import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    remoteBindings: false,
    miniflare: {
      compatibilityDate: '2026-11-08',
      d1Databases: ['CHAIN_DB'],
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)))
      }
    }
  }))],
  test: {
    include: ['chain-worker/tests/**/*.test.ts'],
    setupFiles: ['./chain-worker/tests/setup.ts'],
    fileParallelism: false,
    testTimeout: 30000
  }
});
