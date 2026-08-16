import { Router } from "express";
import { query } from "../db/pool.js";
import { encrypt } from "../lib/crypto.js";
import { hashPassword } from "../lib/password.js";
import { callInstance, pingHealth, type Instance } from "./instanceClient.js";
import { config } from "./config.js";

export const adminRouter = Router();

adminRouter.use((req, res, next) => {
  const key = req.header("x-admin-key");
  if (!key || key !== config.adminKey) return res.status(401).json({ error: "Invalid admin key." });
  next();
});

async function getInstance(id: string): Promise<Instance | undefined> {
  const result = await query<Instance>("select * from instances where id=$1", [id]);
  return result.rows[0];
}

const PUBLIC_INSTANCE_COLUMNS =
  "id, name, kind, origin_url, status, last_checked_at, created_at, updated_at";

// --- Instances --------------------------------------------------------

adminRouter.get("/instances", async (_req, res) => {
  const result = await query(`select ${PUBLIC_INSTANCE_COLUMNS} from instances order by created_at desc`);
  res.json(result.rows);
});

// Registration is a one-shot bootstrap: the caller supplies a real admin
// key for the target instance just for this call, Manager uses it once to
// mint a new, scoped, auth_provider='manager' admin_users row on that
// instance, stores only the freshly-minted credential (encrypted), and
// never persists or logs the bootstrap key itself.
adminRouter.post("/instances", async (req, res) => {
  const { name, originUrl, bootstrapAdminKey, kind } = req.body ?? {};
  if (!name || !originUrl || !bootstrapAdminKey) {
    return res.status(400).json({ error: "name, originUrl, and bootstrapAdminKey are required." });
  }
  if (kind && !["shared", "dedicated"].includes(kind)) {
    return res.status(400).json({ error: "kind must be shared or dedicated." });
  }

  let minted: { id: string; api_key: string };
  try {
    const origin = String(originUrl).replace(/\/$/, "");
    const mintRes = await fetch(`${origin}/admin/admin-users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": bootstrapAdminKey },
      body: JSON.stringify({ name: "Beacon Manager", role: "admin", authProvider: "manager" }),
    });
    const body = await mintRes.json().catch(() => ({}));
    if (!mintRes.ok) {
      return res.status(400).json({ error: `Could not register with that instance: ${body.error || mintRes.status}` });
    }
    minted = body;
  } catch (error: any) {
    return res.status(400).json({ error: `Could not reach ${originUrl}: ${error.message}` });
  }

  let result;
  try {
    result = await query(
      `insert into instances(name, kind, origin_url, encrypted_admin_credential, managed_admin_user_id, status, last_checked_at)
       values($1,coalesce($2,'shared'),$3,$4,$5,'healthy',now())
       returning ${PUBLIC_INSTANCE_COLUMNS}`,
      [String(name).trim(), kind, String(originUrl).replace(/\/$/, ""), encrypt(minted.api_key), minted.id],
    );
  } catch (error: any) {
    if (error?.code === "23505") {
      return res.status(409).json({ error: `An instance at "${originUrl}" is already registered.` });
    }
    throw error;
  }
  res.status(201).json(result.rows[0]);
});

adminRouter.post("/instances/:id/check", async (req, res) => {
  const instance = await getInstance(req.params.id);
  if (!instance) return res.status(404).json({ error: "Instance not found." });
  const healthy = await pingHealth(instance.origin_url);
  const result = await query(
    `update instances set status=$2, last_checked_at=now() where id=$1 returning ${PUBLIC_INSTANCE_COLUMNS}`,
    [instance.id, healthy ? "healthy" : "unreachable"],
  );
  res.json(result.rows[0]);
});

// Best-effort remote revoke (deletes the scoped admin_users row Manager
// minted at registration) before forgetting the instance locally — but the
// local pointer is always removed even if the instance is unreachable, so
// an offline/decommissioned instance doesn't get stuck in the registry.
adminRouter.delete("/instances/:id", async (req, res) => {
  const instance = await getInstance(req.params.id);
  if (!instance) return res.status(404).json({ error: "Instance not found." });

  let remoteRevoked = false;
  try {
    await callInstance(instance, `/admin/admin-users/${instance.managed_admin_user_id}`, { method: "DELETE" });
    remoteRevoked = true;
  } catch {
    // Instance unreachable or credential already gone — proceed with local cleanup regardless.
  }

  await query("delete from instances where id=$1", [instance.id]);
  res.json({ deleted: true, remoteRevoked });
});

// Adopts any project group already marked kind='product' on the instance
// (e.g. created directly on that instance's own dashboard) into Manager's
// registry, so Manager doesn't only know about products it created itself.
adminRouter.post("/instances/:id/sync-products", async (req, res) => {
  const instance = await getInstance(req.params.id);
  if (!instance) return res.status(404).json({ error: "Instance not found." });

  let groups: any[];
  try {
    groups = await callInstance(instance, "/admin/project-groups");
  } catch (error: any) {
    return res.status(502).json({ error: error.message });
  }
  const productGroups = groups.filter((g) => g.kind === "product");

  const synced = [];
  for (const g of productGroups) {
    const result = await query(
      `insert into products(name, instance_id, remote_group_id) values($1,$2,$3)
       on conflict(instance_id, remote_group_id) do update set name=excluded.name, updated_at=now()
       returning *`,
      [g.name, instance.id, g.id],
    );
    synced.push(result.rows[0]);
  }
  res.json({ synced: synced.length, products: synced });
});

// --- Products (cross-instance) -----------------------------------------

adminRouter.get("/products", async (_req, res) => {
  const result = await query(
    `select p.*, i.name as instance_name, i.origin_url as instance_origin_url, i.status as instance_status
     from products p join instances i on i.id = p.instance_id
     order by p.created_at desc`,
  );

  const enriched = await Promise.all(
    result.rows.map(async (product: any) => {
      const instance = await getInstance(product.instance_id);
      if (!instance) return { ...product, projectCount: 0, reachable: false };
      try {
        const projects: any[] = await callInstance(instance, "/admin/projects");
        const members = projects.filter((p) => p.group_id === product.remote_group_id);
        return { ...product, projectCount: members.length, reachable: true };
      } catch {
        return { ...product, projectCount: null, reachable: false };
      }
    }),
  );
  res.json(enriched);
});

adminRouter.get("/products/:id/projects", async (req, res) => {
  const result = await query("select * from products where id=$1", [req.params.id]);
  const product = result.rows[0];
  if (!product) return res.status(404).json({ error: "Product not found." });
  const instance = await getInstance(product.instance_id);
  if (!instance) return res.status(404).json({ error: "Instance not found." });

  try {
    const projects: any[] = await callInstance(instance, "/admin/projects");
    res.json(projects.filter((p) => p.group_id === product.remote_group_id));
  } catch (error: any) {
    res.status(502).json({ error: error.message });
  }
});

adminRouter.post("/products/:id/projects/:projectId/rotate-key", async (req, res) => {
  const result = await query("select * from products where id=$1", [req.params.id]);
  const product = result.rows[0];
  if (!product) return res.status(404).json({ error: "Product not found." });
  const instance = await getInstance(product.instance_id);
  if (!instance) return res.status(404).json({ error: "Instance not found." });

  try {
    const rotated = await callInstance(instance, `/admin/projects/${req.params.projectId}/rotate-key`, { method: "POST" });
    res.json(rotated);
  } catch (error: any) {
    res.status(error.status === 404 ? 404 : 502).json({ error: error.message });
  }
});

// Creates a product on a chosen instance (proxying Beacon's own
// POST /admin/products) and records the resulting group as a locally
// tracked product in one step.
adminRouter.post("/products", async (req, res) => {
  const { instanceId, name, platforms } = req.body ?? {};
  if (!instanceId || !name || !Array.isArray(platforms) || !platforms.length) {
    return res.status(400).json({ error: "instanceId, name, and a non-empty platforms array are required." });
  }
  const instance = await getInstance(instanceId);
  if (!instance) return res.status(404).json({ error: "Instance not found." });

  let remote: { group: any; projects: any[] };
  try {
    remote = await callInstance(instance, "/admin/products", {
      method: "POST",
      body: JSON.stringify({ name, platforms }),
    });
  } catch (error: any) {
    return res.status(error.status ?? 502).json({ error: error.message });
  }

  const localResult = await query(
    `insert into products(name, instance_id, remote_group_id) values($1,$2,$3) returning *`,
    [remote.group.name, instance.id, remote.group.id],
  );

  res.status(201).json({ product: localResult.rows[0], group: remote.group, projects: remote.projects });
});

// --- Embed access (agency logins for the product-scoped /beacon UI) -----

adminRouter.get("/products/:id/embed-credentials", async (req, res) => {
  const result = await query(
    "select id, username, created_at from product_access_credentials where product_id=$1 order by created_at desc",
    [req.params.id],
  );
  res.json(result.rows);
});

adminRouter.post("/products/:id/embed-credentials", async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: "username and password are required." });
  if (String(password).length < 8) return res.status(400).json({ error: "password must be at least 8 characters." });

  const product = await query("select id from products where id=$1", [req.params.id]);
  if (!product.rowCount) return res.status(404).json({ error: "Product not found." });

  let result;
  try {
    result = await query(
      `insert into product_access_credentials(product_id, username, password_hash) values($1,$2,$3)
       returning id, username, created_at`,
      [req.params.id, username, hashPassword(password)],
    );
  } catch (error: any) {
    if (error?.code === "23505") return res.status(409).json({ error: `Username "${username}" is already in use.` });
    throw error;
  }
  res.status(201).json(result.rows[0]);
});

adminRouter.delete("/embed-credentials/:id", async (req, res) => {
  const result = await query("delete from product_access_credentials where id=$1", [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: "Credential not found." });
  res.status(204).end();
});
