create extension if not exists pgcrypto;

-- A registered Beacon deployment. Manager never stores a raw master admin
-- key here — encrypted_admin_credential is always a *scoped* credential
-- Manager itself minted on that instance (auth_provider='manager' on the
-- instance's own admin_users table), so it's independently revocable by
-- deleting that one row on the instance, without touching the instance's
-- master key.
create table if not exists instances (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'shared' check (kind in ('shared', 'dedicated')),
  origin_url text not null unique,
  encrypted_admin_credential text not null,
  managed_admin_user_id text not null,
  status text not null default 'unknown' check (status in ('unknown', 'healthy', 'unreachable')),
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A durable pointer: "this product currently lives on this instance, as
-- this group." Deliberately does not mirror any analytics data — just
-- enough to know where to ask. remote_group_id is that instance's own
-- project_groups.id (a plain uuid string, not a local FK — the referenced
-- row lives in a different database entirely).
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  instance_id uuid not null references instances(id) on delete cascade,
  remote_group_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(instance_id, remote_group_id)
);

-- Login for the embeddable, product-scoped dashboard (agency access to one
-- product's analytics from that product's own web app, at its own
-- /beacon path — see docs/ROADMAP.html Phase 2). Deliberately separate
-- from Manager's own admin key and from any Beacon instance credential:
-- this identity can only ever reach one product, never Manager itself.
create table if not exists product_access_credentials (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  username text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists embed_sessions (
  token text primary key,
  product_id uuid not null references products(id) on delete cascade,
  credential_id uuid not null references product_access_credentials(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists embed_sessions_expires_idx on embed_sessions(expires_at);
