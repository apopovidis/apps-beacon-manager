# Beacon Manager

Central registry and control plane for [Beacon](../apps-analytics-sdk) analytics deployments. Register any reachable Beacon instance, track products across all of them from one place, rotate keys, and grant scoped, embeddable dashboard access to one product at a time (e.g. for an outside agency managing one client's analytics).

Full spec: [`docs/PRD.html`](docs/PRD.html). Build history: [`docs/ROADMAP.html`](docs/ROADMAP.html).

## Why this exists

Beacon runs as one shared, multi-tenant instance by default — that's the right default and stays the default. But at real scale, some products eventually need their own dedicated instance (their own database, possibly their own deployment), and someone needs one place to see and manage every instance that now exists, rather than bookmarking N separate dashboard URLs and N separate admin keys. That's this app. It holds a registry, not a copy of anyone's analytics data.

## Quickstart

```bash
docker compose up -d       # local Postgres on :54333
npm install
npm run env:dev
npm run db:migrate
npm run dev                 # http://localhost:4102
```

Open `http://localhost:4102`, enter `MANAGER_ADMIN_KEY` from `.env.dev`.

**Register a Beacon instance**: you'll need that instance's own admin key (its `ANALYTICS_ADMIN_KEY`) as a one-time bootstrap credential — Manager uses it once to mint its own scoped, independently-revocable credential, and never stores the bootstrap key itself.

## The embeddable dashboard (agency access)

From a product's page in Manager, "Embed access" creates a username/password login scoped to just that one product. Drop `embed-snippet/beacon.html` (edited with your Manager origin and product id) at a web app's own `/beacon` route — see [`embed-snippet/README.md`](embed-snippet/README.md) for exact steps per hosting stack. No backend logic runs on the host app; the real dashboard, login, and every request's scoping check all live on Manager.

## Testing

```bash
npm test          # real Postgres, hermetic fake-Beacon HTTP stub — no external dependency
npm run typecheck
```

## Status

v1. Instance registry + cross-instance products + embeddable scoped dashboard are done and verified live against a real Beacon instance. Dedicated-instance *provisioning* (standing up a brand new instance, not just registering an existing one) is not built yet — see the "Next" table in `docs/ROADMAP.html`.
