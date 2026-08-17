# Beacon Manager (`@autopilot/beacon-manager`)

Central registry and control plane for Beacon analytics deployments. Sibling repo: **`../apps-analytics-sdk`** — that's Beacon itself (the thing this app manages instances of). Read that repo's `CLAUDE.md` too if you're working across both; this doc assumes you already know what Beacon is.

**Critical architectural point**: Manager's own database stores *metadata only* — a registry of instances and products. It never copies, caches, or duplicates any instance's actual analytics data. Every "list projects" / "get summary" / etc. call fans out live, in real time, to the target instance's own admin API.

## Stack & layout

Deliberately mirrors `apps-analytics-sdk`'s conventions exactly (same `pg`-direct-no-ORM approach, same idempotent `schema.sql`, same Vitest+Supertest test style, same vanilla-JS single-file dashboard) — if something here looks unfamiliar, check how the sibling repo does the equivalent thing first.

- `src/db/schema.sql` — `instances`, `products`, `product_access_credentials`, `embed_sessions`. Idempotent, same style as Beacon's.
- `src/lib/crypto.ts` — AES-256-GCM, keyed by `MANAGER_ENCRYPTION_KEY`. **This key is independent of any managed instance's own `BEACON_ENCRYPTION_KEY`** — encrypted blobs are never portable between the two apps.
- `src/lib/password.ts` — scrypt-based password hashing for embed-dashboard logins (no bcrypt dependency; per-password random salt, `timingSafeEqual` verification).
- `src/service/instanceClient.ts` — `callInstance(instance, path, opts)`, the one place that talks to a managed Beacon instance's admin API (decrypts the stored credential, makes the HTTP call, throws with `.status` on non-2xx). `pingHealth(originUrl)` for the unauthenticated `/health` check.
- `src/service/admin.ts` — Manager's own admin API (gated by `MANAGER_ADMIN_KEY`): instance registration/health-check/removal, cross-instance product listing/creation, proxied key rotation, embed-credential management.
- `src/service/publicEmbed.ts` — the **public** (no admin key) API the embeddable `/beacon` dashboard talks to: login, then a curated set of project/summary/events/web-analytics routes. This is the real security boundary — see below.
- `public/index.html` — Manager's own admin dashboard (register instances, browse products).
- `public/embed.html` / `embed-snippet/beacon.html` — the product-scoped, login-gated dashboard an agency uses, and the tiny static file a web app drops at its own `/beacon` route to embed it (an iframe pointer to Manager's hosted `/embed/:productId` page — see `embed-snippet/README.md`).
- `test/fakeBeaconInstance.ts` — a minimal in-process HTTP stub that mimics enough of Beacon's admin API to test registration/proxying hermetically, without depending on a real Beacon dev server being up. It deliberately enforces "bootstrap key only works once, minted key required after" so a Manager bug that never switched credentials would fail the test.

## Running it

```bash
docker compose up -d          # local Postgres on :54333 (note: different port than Beacon's :54332)
npm install
npm run env:dev
npm run db:migrate
npm run dev                    # serves on :4102 (MANAGER_PORT)
npm test
npm run typecheck
```

`.env.dev`/`.env.prod` are gitignored (only `.env.example` is tracked) — same convention as the sibling repo.

## The credential model — read this before touching auth code

Three completely distinct identity types, don't conflate them:

1. **`MANAGER_ADMIN_KEY`** — gates Manager's own admin API (`/admin/*`). You, the operator, hold this.
2. **Per-instance scoped credential** — minted *by* Manager *on* each Beacon instance it manages, at registration time. Registration takes a one-time **bootstrap** admin key for that instance (used exactly once, to call the instance's own `POST /admin/admin-users` with `authProvider: "manager"`), and Manager stores *only* the newly-minted result, AES-256-GCM encrypted under `MANAGER_ENCRYPTION_KEY`. The bootstrap key is never persisted or logged. Removing an instance revokes this credential on the target (best-effort — always removed locally even if the target is unreachable).
3. **Embed credentials** (`product_access_credentials` + `embed_sessions`) — username/password for one external, unprivileged party (e.g. an agency) to log into one product's scoped dashboard. Completely separate from both of the above — this identity can never reach Manager's own admin API or any Beacon instance's admin API directly; it only ever talks to `publicEmbed.ts`'s curated proxy routes, and every `:id`-bearing request there re-verifies (live, not cached) that the requested project actually belongs to that session's product before proxying anything. That live re-check is the actual security boundary, not the login step.

## Multi-product architecture roadmap

Full detail in `docs/PRD.html` / `docs/ROADMAP.html` (Phase 1 = registry v1, Phase 2 = embeddable UI, both done — 25/25 tests passing). This app is Phase B + Phase D of the overall roadmap that lives primarily in the sibling repo's `docs/ROADMAP.html`; Phase C (dedicated-instance provisioning) is in progress there.

### Live test in progress — read this before touching Railway/Supabase state

Testing whether a genuinely separate, independently-deployed Beacon instance (not just a row in the shared local one) can be registered and managed from here — the actual point of building the instance registry in the first place.

- A second Beacon instance is deployed on Railway (`https://apps-analytics-sdk-production.up.railway.app`), pointed at a dedicated Supabase project (ref `uccbvarrihdtsjingmpu`).
- **It is not currently reachable** — `/health` on it is returning 502 "Application failed to respond" from Railway's edge (was working, then regressed after switching the Railway instance's DB connection string from Supabase's direct endpoint to the connection pooler, to work around a suspected IPv6-reachability issue). Root cause not yet confirmed — waiting on Railway's deploy logs.
- **Manager itself is not currently running** — it was stopped after the Phase B/Phase D verification passes. Nothing has been registered from this session yet against the Railway instance.
- Once the Railway instance is reachable again: `npm run dev` here, then `POST http://localhost:4102/admin/instances` with `{ name, originUrl: "https://apps-analytics-sdk-production.up.railway.app", bootstrapAdminKey: <the Railway service's ANALYTICS_ADMIN_KEY> }`, then create a product on it and confirm it shows up correctly in `GET /admin/products` with a live project count.
- Git: `git@github.com:apopovidis/apps-beacon-manager.git`, branch `main`, pushed through commit `4347ad0` ("Initial commit: Beacon Manager v1").
