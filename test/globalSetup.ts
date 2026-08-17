import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Mirrors apps-analytics-sdk's test/globalSetup.ts: refuses to run against
 * a Supabase (production) database, since these are real integration tests
 * against a real Postgres. Teardown is scoped by name prefix — every
 * test-created instance goes through registerFakeInstance() (test/helpers.ts),
 * which always names it "Test Instance" — rather than clearing both tables
 * outright. A real, manually-registered instance (e.g. an actual deployed
 * Beacon instance you've registered for real use) previously got wiped by
 * this teardown because it made the "nothing real lives here" assumption;
 * don't repeat that mistake.
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
      // products cascades off instances, but delete it explicitly first
      // anyway so a product whose instance was already removed mid-test
      // doesn't get left behind.
      await pool.query(
        "delete from products where instance_id in (select id from instances where name like 'Test Instance%')",
      );
      const result = await pool.query("delete from instances where name like 'Test Instance%'");
      if (result.rowCount) {
        console.log(`[test cleanup] removed ${result.rowCount} test instance(s)`);
      }
    } finally {
      await pool.end();
    }
  };
}
