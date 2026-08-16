import pg from "pg";
import { config } from "../service/config.js";

const ssl = config.databaseUrl.includes("supabase.co")
  ? { rejectUnauthorized: false }
  : undefined;

export const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl });

export async function query<T extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
) {
  return pool.query<T>(text, values);
}
