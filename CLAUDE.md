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

### Service-isolation test — resolved and verified live

The question this answered: can a genuinely separate, independently-deployed Beacon instance (not just a row in the shared local one) be registered and managed from here? **Yes, confirmed live, end to end.**

- A second Beacon instance runs on Railway (`https://apps-analytics-sdk-production.up.railway.app`), backed by its own dedicated Supabase project (ref `uccbvarrihdtsjingmpu`) — a real, separate deployment, not a simulation.
- Getting there surfaced and fixed three real issues (all now resolved, don't re-diagnose them): (1) Beacon needed to listen on Railway's injected `PORT`, not just `ANALYTICS_PORT` (`../apps-analytics-sdk` commit `3ace303`); (2) `pg.Pool` had no `'error'` listener, so an idle-client connection failure crashed the whole process instead of just logging (commit `787981b`) — found via a bad Supabase pooler connection string (wrong region in the hostname) that was rejecting every connection; (3) Railway's public domain had a fixed target port that stopped matching what the app actually listened on once the `PORT` fix shipped — fixed in Railway's own Networking settings, nothing to do with this codebase.
- **Currently registered**: instance id `592c0896-72bc-432f-9eb9-7321d0f53637` ("Railway (dedicated)"), status `healthy`. A real product ("Dedicated Instance Test", one Web project) is tracked on it — `GET /admin/products` correctly shows `projectCount: 1, reachable: true`, fanned out live from Manager to Railway's real database.
- Confirmed directly against Railway's own database: the scoped `admin_users` row Manager minted there has `auth_provider='manager'`, not the master key.
- Manager is running locally right now (`npm run dev`, background) against the local Postgres in `docker-compose.yml` — a leftover container from before this repo was renamed from `beacon-manager` (already had the schema applied, so it was reused rather than recreated; harmless, but if you `docker compose up` fresh and get a port-already-allocated error on `:54333`, that's why — `docker ps` to check what's already bound before assuming something's broken).
- Git: `git@github.com:apopovidis/apps-beacon-manager.git`, branch `main`.
