import { config as loadEnvironment } from "dotenv";
import { fileURLToPath } from "node:url";

loadEnvironment({
  path: fileURLToPath(new URL("../../.env", import.meta.url)),
  override: true,
});

export const config = {
  port: Number(process.env.MANAGER_PORT ?? 4102),
  databaseUrl:
    process.env.MANAGER_DATABASE_URL ??
    "postgresql://manager:manager@localhost:54333/manager",
  adminKey: process.env.MANAGER_ADMIN_KEY ?? "local-manager-admin-key-change-me",
};
