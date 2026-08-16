import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A minimal HTTP stand-in for a real Beacon instance's admin API — enough
 * surface to exercise Manager's registration/proxy logic against a real
 * network call, without depending on another repo's dev server being up.
 * Deliberately enforces the bootstrap-key-once-then-minted-key-after
 * behavior Manager is supposed to follow, so a Manager bug that kept using
 * the bootstrap key (or never switched to the minted one) would fail here.
 */
export type FakeBeacon = {
  url: string;
  bootstrapKey: string;
  mintedKey: string;
  wasRevoked: () => boolean;
  close: () => Promise<void>;
};

export function startFakeBeacon(): Promise<FakeBeacon> {
  const bootstrapKey = "bootstrap-" + Math.random().toString(36).slice(2);
  const mintedKey = "minted-" + Math.random().toString(36).slice(2);
  const mintedUserId = "manager-user-" + Math.random().toString(36).slice(2);
  const existingGroupId = "group-existing-" + Math.random().toString(36).slice(2);

  const state = {
    projects: [
      { id: "proj-existing", name: "Existing Product — Web", slug: "existing-web", api_key: "proj-existing-key", tier: "basic", group_id: existingGroupId, feature: null },
    ],
    groups: [
      { id: existingGroupId, name: "Existing Product", kind: "product", sort_order: 0 },
      { id: "group-not-a-product", name: "Just a folder", kind: "group", sort_order: 1 },
    ],
    revoked: false,
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const key = req.headers["x-admin-key"];
      const url = req.url ?? "";
      const method = req.method ?? "GET";

      if (url === "/health") return json(200, { ok: true });

      if (method === "POST" && url === "/admin/admin-users") {
        if (key !== bootstrapKey) return json(401, { error: "Invalid admin key." });
        return json(201, { id: mintedUserId, name: "Beacon Manager", role: "admin", auth_provider: "manager", api_key: mintedKey });
      }

      // Every other route requires the MINTED key, not the one-time bootstrap key.
      if (key !== mintedKey) return json(401, { error: "Invalid admin key." });

      if (method === "DELETE" && url === `/admin/admin-users/${mintedUserId}`) {
        state.revoked = true;
        return json(204, {});
      }
      if (method === "GET" && url === "/admin/project-groups") return json(200, state.groups);
      if (method === "GET" && url === "/admin/projects") return json(200, state.projects);
      if (method === "POST" && url === "/admin/products") {
        const parsed = JSON.parse(body || "{}");
        const newGroupId = "group-new-" + Math.random().toString(36).slice(2);
        const newProjects = (parsed.platforms ?? []).map((p: any, i: number) => ({
          id: `proj-new-${i}-${Math.random().toString(36).slice(2)}`,
          name: `${parsed.name} — ${p.name}`,
          slug: p.slug,
          api_key: `key-${Math.random().toString(36).slice(2)}`,
          tier: "basic",
          group_id: newGroupId,
          platform: p.platform ?? "web",
        }));
        const newGroup = { id: newGroupId, name: parsed.name, kind: "product", sort_order: state.groups.length };
        state.groups.push(newGroup);
        state.projects.push(...newProjects);
        return json(201, { group: newGroup, projects: newProjects });
      }
      const rotateMatch = url.match(/^\/admin\/projects\/([^/]+)\/rotate-key$/);
      if (method === "POST" && rotateMatch) {
        const project = state.projects.find((p) => p.id === rotateMatch[1]);
        if (!project) return json(404, { error: "Project not found." });
        project.api_key = "rotated-" + Math.random().toString(36).slice(2);
        return json(200, project);
      }
      const summaryMatch = url.match(/^\/admin\/projects\/([^/]+)\/summary$/);
      if (method === "GET" && summaryMatch) {
        const project = state.projects.find((p) => p.id === summaryMatch[1]);
        if (!project) return json(404, { error: "Project not found." });
        return json(200, { eventCount: 42, personCount: 7 });
      }
      const eventsMatch = url.match(/^\/admin\/projects\/([^/]+)\/events/);
      if (method === "GET" && eventsMatch) {
        const project = state.projects.find((p) => p.id === eventsMatch[1]);
        if (!project) return json(404, { error: "Project not found." });
        return json(200, [{ event_name: "page_viewed", source_key: "web", occurred_at: new Date().toISOString() }]);
      }
      const webAnalyticsMatch = url.match(/^\/admin\/projects\/([^/]+)\/web-analytics/);
      if (method === "GET" && webAnalyticsMatch) {
        const project = state.projects.find((p) => p.id === webAnalyticsMatch[1]);
        if (!project) return json(404, { error: "Project not found." });
        return json(200, { pageviews: 100, uniqueVisitors: 40, bounceRate: 0.3 });
      }

      json(404, { error: "not found in fake beacon" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        bootstrapKey,
        mintedKey,
        wasRevoked: () => state.revoked,
        // closeAllConnections (not just close) — otherwise a lingering
        // keep-alive socket from this server can still be sitting in
        // undici's connection pool when a later test's server gets
        // assigned the same ephemeral port, producing a confusing
        // "not valid HTTP" parse error on an unrelated test.
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
