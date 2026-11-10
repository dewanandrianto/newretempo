import { defineConfig } from 'drizzle-kit';

// Local schema tooling only: no credentials, account IDs, or remote migration target.
// Hand-authored D1 migrations also contain security triggers. Do not replace them
// with schema-only generated SQL; review trigger preservation on every migration.
export default defineConfig({
  dialect: 'sqlite',
  schema: './worker/src/db/schema.ts',
  out: './worker/migrations',
  strict: true,
  verbose: true,
});
