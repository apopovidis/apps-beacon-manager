import { describe, it, expect, afterEach } from "vitest";
import { agent, adminHeaders, registerFakeInstance } from "./helpers.js";

describe("auth", () => {
  it("rejects requests with no admin key", async () => {
    const res = await agent.get("/admin/instances");
    expect(res.status).toBe(401);
  });

  it("rejects requests with a garbage admin key", async () => {
    const res = await agent.get("/admin/instances").set({ "x-admin-key": "not-a-real-key" });
    expect(res.status).toBe(401);
  });
});

describe("instance registration", () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!();
  });

  it("mints a scoped credential via the bootstrap key and never exposes it back", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);

    expect(instance.origin_url).toBe(fake.url);
    expect(instance.status).toBe("healthy");
    expect(instance).not.toHaveProperty("encrypted_admin_credential");
    expect(instance).not.toHaveProperty("bootstrapAdminKey");

    const list = await agent.get("/admin/instances").set(adminHeaders);
    expect(list.body.some((i: any) => i.id === instance.id)).toBe(true);
  });

  it("rejects registration when the bootstrap key is wrong", async () => {
    const fake = await (await import("./fakeBeaconInstance.js")).startFakeBeacon();
    try {
      const res = await agent
        .post("/admin/instances")
        .set(adminHeaders)
        .send({ name: "Bad", originUrl: fake.url, bootstrapAdminKey: "wrong-key" });
      expect(res.status).toBe(400);
    } finally {
      await fake.close();
    }
  });

  it("rejects registering the same origin twice", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);
    const dupe = await agent
      .post("/admin/instances")
      .set(adminHeaders)
      .send({ name: "Dupe", originUrl: instance.origin_url, bootstrapAdminKey: fake.bootstrapKey });
    expect(dupe.status).toBe(409);
  });

  it("health-checks a registered instance", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);
    const check = await agent.post(`/admin/instances/${instance.id}/check`).set(adminHeaders);
    expect(check.status).toBe(200);
    expect(check.body.status).toBe("healthy");
  });

  it("reports unreachable after the instance goes down", async () => {
    const { instance, fake } = await registerFakeInstance();
    await fake.close();
    const check = await agent.post(`/admin/instances/${instance.id}/check`).set(adminHeaders);
    expect(check.status).toBe(200);
    expect(check.body.status).toBe("unreachable");
  });

  it("removing an instance revokes its scoped credential on the target and forgets it locally", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);
    const del = await agent.delete(`/admin/instances/${instance.id}`).set(adminHeaders);
    expect(del.status).toBe(200);
    expect(del.body.remoteRevoked).toBe(true);
    expect(fake.wasRevoked()).toBe(true);

    const list = await agent.get("/admin/instances").set(adminHeaders);
    expect(list.body.some((i: any) => i.id === instance.id)).toBe(false);
  });

  it("removing an instance still succeeds locally even if the instance is unreachable", async () => {
    const { instance, fake } = await registerFakeInstance();
    await fake.close();
    const del = await agent.delete(`/admin/instances/${instance.id}`).set(adminHeaders);
    expect(del.status).toBe(200);
    expect(del.body.remoteRevoked).toBe(false);
  });
});

describe("products", () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!();
  });

  it("adopts a pre-existing product group via sync-products, ignoring non-product groups", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);

    const sync = await agent.post(`/admin/instances/${instance.id}/sync-products`).set(adminHeaders);
    expect(sync.status).toBe(200);
    expect(sync.body.synced).toBe(1);
    expect(sync.body.products[0].name).toBe("Existing Product");

    const products = await agent.get("/admin/products").set(adminHeaders);
    const synced = products.body.find((p: any) => p.instance_id === instance.id);
    expect(synced).toBeTruthy();
    expect(synced.projectCount).toBe(1);
    expect(synced.reachable).toBe(true);
  });

  it("creates a product on a chosen instance and tracks it locally in one call", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);

    const created = await agent
      .post("/admin/products")
      .set(adminHeaders)
      .send({
        instanceId: instance.id,
        name: "Brand New Product",
        platforms: [{ name: "Web", slug: "bnp-web", platform: "web" }],
      });
    expect(created.status).toBe(201);
    expect(created.body.group.name).toBe("Brand New Product");
    expect(created.body.projects).toHaveLength(1);
    expect(created.body.product.instance_id).toBe(instance.id);

    const list = await agent.get("/admin/products").set(adminHeaders);
    expect(list.body.some((p: any) => p.name === "Brand New Product")).toBe(true);
  });

  it("proxies key rotation for a project inside a tracked product", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);
    await agent.post(`/admin/instances/${instance.id}/sync-products`).set(adminHeaders);
    const products = await agent.get("/admin/products").set(adminHeaders);
    const product = products.body[0];

    const projects = await agent.get(`/admin/products/${product.id}/projects`).set(adminHeaders);
    expect(projects.status).toBe(200);
    const oldKey = projects.body[0].api_key;

    const rotate = await agent
      .post(`/admin/products/${product.id}/projects/${projects.body[0].id}/rotate-key`)
      .set(adminHeaders);
    expect(rotate.status).toBe(200);
    expect(rotate.body.api_key).not.toBe(oldKey);
  });

  it("reports a product as unreachable (not an error) when its instance is down", async () => {
    const { instance, fake } = await registerFakeInstance();
    await agent.post(`/admin/instances/${instance.id}/sync-products`).set(adminHeaders);
    await fake.close();

    const products = await agent.get("/admin/products").set(adminHeaders);
    expect(products.status).toBe(200);
    expect(products.body[0].reachable).toBe(false);
  });
});
