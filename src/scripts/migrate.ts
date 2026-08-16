import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "../db/pool.js";

const path = fileURLToPath(new URL("../db/schema.sql", import.meta.url));
await pool.query(await readFile(path, "utf8"));
console.log("Beacon Manager database migrated");
await pool.end();
