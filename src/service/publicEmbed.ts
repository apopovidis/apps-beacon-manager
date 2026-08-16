import { Router } from "express";
import { randomBytes } from "node:crypto";
import { query } from "../db/pool.js";
import { verifyPassword } from "../lib/password.js";
import { callInstance, type Instance } from "./instanceClient.js";

export const publicEmbedRouter = Router();

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h — an agency's working session, not a long-lived credential.

type Product = { id: string; name: string; instance_id: string; remote_group_id: string };

async function getProductAndInstance(productId: string): Promise<{ product: Product; instance: Instance } | undefined> {
  const productResult = await query<Product>("select * from products where id=$1", [productId]);
  const product = productResult.rows[0];
  if (!product) return undefined;
  const instanceResult = await query<Instance>("select * from instances where id=$1", [product.instance_id]);
  const instance = instanceResult.rows[0];
  if (!instance) return undefined;
  return { product, instance };
}

publicEmbedRouter.post("/products/:productId/embed-login", async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: "username and password are required." });

  const credResult = await query<{ id: string; product_id: string; password_hash: string }>(
    "select id, product_id, password_hash from product_access_credentials where username=$1",
    [username],
  );
  const cred = credResult.rows[0];
  // Same generic error whether the username doesn't exist, belongs to a
  // different product than this login URL, or the password is wrong — never
  // leak which case it was.
  if (!cred || cred.product_id !== req.params.productId || !verifyPassword(password, cred.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  const resolved = await getProductAndInstance(req.params.productId);
  if (!resolved) return res.status(404).json({ error: "Product not found." });

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query("insert into embed_sessions(token, product_id, credential_id, expires_at) values($1,$2,$3,$4)", [
    token,
    req.params.productId,
    cred.id,
    expiresAt,
  ]);
  res.json({ token, expiresAt, productName: resolved.product.name });
});

async function requireEmbedSession(req: any, res: any, next: any) {
  const auth = req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (!token) return res.status(401).json({ error: "Missing session token." });

  const sessionResult = await query<{ product_id: string; expires_at: string }>(
    "select product_id, expires_at from embed_sessions where token=$1",
    [token],
  );
  const session = sessionResult.rows[0];
  if (!session || new Date(session.expires_at) < new Date()) {
    return res.status(401).json({ error: "Session expired or invalid — please log in again." });
  }

  const resolved = await getProductAndInstance(session.product_id);
  if (!resolved) return res.status(404).json({ error: "Product no longer exists." });
  req.embedProduct = resolved.product;
  req.embedInstance = resolved.instance;
  next();
}

publicEmbedRouter.use("/embed", requireEmbedSession);

/** The real enforcement boundary: regardless of what a client asks for,
 * only project ids that actually belong to this session's product (as of
 * right now, fetched live — never cached/stale) are ever considered valid.
 * Every :id-bearing route below calls this before proxying anything. */
async function scopedProjectIds(product: Product, instance: Instance): Promise<Set<string>> {
  const projects: any[] = await callInstance(instance, "/admin/projects");
  return new Set(projects.filter((p) => p.group_id === product.remote_group_id).map((p) => p.id));
}

publicEmbedRouter.get("/embed/projects", async (req: any, res) => {
  try {
    const projects: any[] = await callInstance(req.embedInstance, "/admin/projects");
    res.json(projects.filter((p) => p.group_id === req.embedProduct.remote_group_id));
  } catch (error: any) {
    res.status(502).json({ error: error.message });
  }
});

function scopedProjectRoute(path: string, upstreamPath: (id: string, req: any) => string) {
  publicEmbedRouter.get(`/embed/projects/:id${path}`, async (req: any, res) => {
    try {
      const allowed = await scopedProjectIds(req.embedProduct, req.embedInstance);
      if (!allowed.has(req.params.id)) return res.status(403).json({ error: "Not part of this product." });
      const body = await callInstance(req.embedInstance, upstreamPath(req.params.id, req));
      res.json(body);
    } catch (error: any) {
      res.status(error.status ?? 502).json({ error: error.message });
    }
  });
}

scopedProjectRoute("/summary", (id) => `/admin/projects/${id}/summary`);
scopedProjectRoute("/events", (id, req) => `/admin/projects/${id}/events?limit=${Number(req.query.limit) || 50}`);
scopedProjectRoute("/web-analytics", (id, req) => `/admin/projects/${id}/web-analytics?days=${Number(req.query.days) || 30}`);
