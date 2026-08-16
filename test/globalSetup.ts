import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Mirrors apps-analytics-sdk's test/globalSetup.ts: refuses to run against
 * a Supabase (production) database, since these are real integration tests
 * against a real Postgres. Manager's local dev database is single-purpose
 * (nothing but test/registry data lives in it yet), so teardown just clears
 * both tables outright rather than needing a name-prefix filter.
 */
export default async function globalSetup() {
  loadEnv({ path: fileURLToPath(new URL("../.env", import.meta.url)) });
  const url = process.env.MANAGER_DATABASE_URL ?? "";
  if (url.includes("supabase.co")) {
    throw new Error(
      "Refusing to run the integration test suite against a Supabase (production) database. " +
        "Run `npm run env:dev` first — tests must only run against local Postgres.",
    );
  }

  return async () => {
    const pool = new pg.Pool({ connectionString: url });
    try {
      await pool.query("delete from products");
      await pool.query("delete from instances");
    } finally {
      await pool.end();
    }
  };
}
