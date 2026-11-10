import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  resolve: { alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) } },
  plugins: [cloudflareTest(async () => ({
    remoteBindings: false,
    miniflare: {
      compatibilityDate: '2026-11-08',
      d1Databases: ['DB'],
      bindings: {
        APP_ENV: 'test',
        SESSION_SECRET: 'retempo-local-test-pepper-not-for-production-00000000',
        APP_ORIGINS: 'https://app.test',
        SIWE_DOMAIN: 'app.test',
        SIWE_URI: 'https://app.test',
        SIWE_CHAIN_ID: '5042002',
        EMAIL_MODE: 'test',
        REQUIRE_VERIFIED_EMAIL: 'false',
        COOKIE_SECURE: 'false',
        TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url))),
      },
    },
  }))],
  test: {
    include: ['worker/tests/**/*.test.ts'],
    setupFiles: ['./worker/tests/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
})
