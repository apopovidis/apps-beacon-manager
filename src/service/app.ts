import express from "express";
import cors from "cors";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adminRouter } from "./admin.js";
import { publicEmbedRouter } from "./publicEmbed.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/admin", adminRouter);
  // Deliberately separate from /admin: no admin key involved anywhere on
  // this path — login is a product-scoped username/password, meant to be
  // reachable from an agency's browser on a different site entirely.
  app.use("/public", publicEmbedRouter);
  // The real, hosted, product-scoped dashboard. :productId is read client-
  // side from the URL — same static file for every product, so this is a
  // plain sendFile rather than server-side templating.
  app.get("/embed/:productId", (_req, res) => {
    res.sendFile(join(__dirname, "../../public/embed.html"));
  });
  app.use(express.static(join(__dirname, "../../public")));

  return app;
}
