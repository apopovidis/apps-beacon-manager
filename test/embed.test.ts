import { describe, it, expect, afterEach } from "vitest";
import { agent, adminHeaders, registerFakeInstance } from "./helpers.js";
import { query } from "../src/db/pool.js";

async function createProduct(instanceId: string, name: string, platformName = "Web") {
  const res = await agent
    .post("/admin/products")
    .set(adminHeaders)
    .send({ instanceId, name, platforms: [{ name: platformName, slug: `${platformName.toLowerCase()}-${Math.random().toString(36).slice(2)}`, platform: "web" }] });
  if (res.status !== 201) throw new Error(`createProduct failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body; // { product, group, projects }
}

async function createCredential(productId: string, username: string, password = "correct-horse-battery") {
  const res = await agent
    .post(`/admin/products/${productId}/embed-credentials`)
    .set(adminHeaders)
    .send({ username, password });
  if (res.status !== 201) throw new Error(`createCredential failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...res.body, password };
}

describe("embed login + scoped access", () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!();
  });

  it("logs in with valid product-scoped credentials", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);
    const { product } = await createProduct(instance.id, "Product A");
    const username = `agency-${Math.random().toString(36).slice(2)}`;
    await createCredential(product.id, username);

    const login = await agent
      .post(`/public/products/${product.id}/embed-login`)
      .send({ username, password: "correct-horse-battery" });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
    expect(login.body.productName).toBe("Product A");
  });

  it("rejects a wrong password", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);
    const { product } = await createProduct(instance.id, "Product A");
    const username = `agency-${Math.random().toString(36).slice(2)}`;
    await createCredential(product.id, username);

    const login = await agent
      .post(`/public/products/${product.id}/embed-login`)
      .send({ username, password: "totally-wrong" });
    expect(login.status).toBe(401);
  });

  it("rejects login when the credentials belong to a different product than the login URL", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);
    const { product: productA } = await createProduct(instance.id, "Product A");
    const { product: productB } = await createProduct(instance.id, "Product B");
    const username = `agency-${Math.random().toString(36).slice(2)}`;
    await createCredential(productA.id, username);

    // Correct username/password, but hitting Product B's login URL.
    const login = await agent
      .post(`/public/products/${productB.id}/embed-login`)
      .send({ username, password: "correct-horse-battery" });
    expect(login.status).toBe(401);
  });

  it("rejects requests with no session token", async () => {
    const res = await agent.get("/public/embed/projects");
    expect(res.status).toBe(401);
  });

  it("rejects requests with a garbage session token", async () => {
    const res = await agent.get("/public/embed/projects").set({ Authorization: "Bearer not-a-real-token" });
    expect(res.status).toBe(401);
  });

  it("rejects an expired session", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);
    const { product } = await createProduct(instance.id, "Product A");
    const username = `agency-${Math.random().toString(36).slice(2)}`;
    const cred = await createCredential(product.id, username);
    const login = await agent.post(`/public/products/${product.id}/embed-login`).send({ username, password: cred.password });

    // Force the real session row to already be expired, rather than waiting out the real 12h TTL.
    await query("update embed_sessions set expires_at = now() - interval '1 minute' where token=$1", [login.body.token]);

    const res = await agent.get("/public/embed/projects").set({ Authorization: `Bearer ${login.body.token}` });
    expect(res.status).toBe(401);
  });

  it("scoped project list only includes this product's projects", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);
    const { product } = await createProduct(instance.id, "Product A");
    const username = `agency-${Math.random().toString(36).slice(2)}`;
    const cred = await createCredential(product.id, username);
    const login = await agent.post(`/public/products/${product.id}/embed-login`).send({ username, password: cred.password });

    const projects = await agent.get("/public/embed/projects").set({ Authorization: `Bearer ${login.body.token}` });
    expect(projects.status).toBe(200);
    expect(projects.body).toHaveLength(1);
    expect(projects.body[0].name).toContain("Product A");
  });

  it("allows fetching summary/events/web-analytics for a project inside this product", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);
    const { product, projects } = await createProduct(instance.id, "Product A");
    const username = `agency-${Math.random().toString(36).slice(2)}`;
    const cred = await createCredential(product.id, username);
    const login = await agent.post(`/public/products/${product.id}/embed-login`).send({ username, password: cred.password });
    const auth = { Authorization: `Bearer ${login.body.token}` };
    const projectId = projects[0].id;

    const summary = await agent.get(`/public/embed/projects/${projectId}/summary`).set(auth);
    expect(summary.status).toBe(200);
    const events = await agent.get(`/public/embed/projects/${projectId}/events`).set(auth);
    expect(events.status).toBe(200);
    const webAnalytics = await agent.get(`/public/embed/projects/${projectId}/web-analytics`).set(auth);
    expect(webAnalytics.status).toBe(200);
  });

  // The critical case: a valid, unexpired session for Product A must never
  // be able to reach Product B's data, even by guessing/copying a real
  // project id — this is the actual security boundary the whole embeddable
  // /beacon UI depends on.
  it("blocks a Product A session from reading a Product B project, even with a real project id", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);
    const { product: productA } = await createProduct(instance.id, "Product A");
    const { projects: projectsB } = await createProduct(instance.id, "Product B");
    const username = `agency-${Math.random().toString(36).slice(2)}`;
    const cred = await createCredential(productA.id, username);
    const login = await agent.post(`/public/products/${productA.id}/embed-login`).send({ username, password: cred.password });
    const auth = { Authorization: `Bearer ${login.body.token}` };

    const otherProjectId = projectsB[0].id;
    const summary = await agent.get(`/public/embed/projects/${otherProjectId}/summary`).set(auth);
    expect(summary.status).toBe(403);
    const events = await agent.get(`/public/embed/projects/${otherProjectId}/events`).set(auth);
    expect(events.status).toBe(403);

    // And Product B never shows up in Product A's scoped project list either.
    const list = await agent.get("/public/embed/projects").set(auth);
    expect(list.body.some((p: any) => p.id === otherProjectId)).toBe(false);
  });

  it("revoking a credential immediately breaks future logins (existing sessions still expire naturally)", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);
    const { product } = await createProduct(instance.id, "Product A");
    const username = `agency-${Math.random().toString(36).slice(2)}`;
    const cred = await createCredential(product.id, username);

    await agent.delete(`/admin/embed-credentials/${cred.id}`).set(adminHeaders);

    const login = await agent.post(`/public/products/${product.id}/embed-login`).send({ username, password: cred.password });
    expect(login.status).toBe(401);
  });

  it("rejects a duplicate username", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);
    const { product } = await createProduct(instance.id, "Product A");
    const username = `agency-${Math.random().toString(36).slice(2)}`;
    await createCredential(product.id, username);
    const res = await agent
      .post(`/admin/products/${product.id}/embed-credentials`)
      .set(adminHeaders)
      .send({ username, password: "another-password" });
    expect(res.status).toBe(409);
  });

  it("rejects a password shorter than 8 characters", async () => {
    const { instance, fake } = await registerFakeInstance();
    cleanup.push(fake.close);
    const { product } = await createProduct(instance.id, "Product A");
    const res = await agent
      .post(`/admin/products/${product.id}/embed-credentials`)
      .set(adminHeaders)
      .send({ username: `agency-${Math.random().toString(36).slice(2)}`, password: "short" });
    expect(res.status).toBe(400);
  });
});
