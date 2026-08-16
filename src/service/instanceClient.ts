import { decrypt } from "../lib/crypto.js";

export type Instance = {
  id: string;
  name: string;
  kind: string;
  origin_url: string;
  encrypted_admin_credential: string;
  managed_admin_user_id: string;
  status: string;
};

/** Calls a registered instance's real admin API using its stored, scoped
 * credential. Throws with a clear message on network failure or a non-2xx
 * response so callers can surface "instance unreachable" distinctly from a
 * validation error the instance itself returned. */
export async function callInstance(instance: Instance, path: string, opts: RequestInit = {}) {
  const adminKey = decrypt(instance.encrypted_admin_credential);
  let res: Response;
  try {
    res = await fetch(`${instance.origin_url.replace(/\/$/, "")}${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json", "x-admin-key": adminKey, ...(opts.headers ?? {}) },
    });
  } catch (error: any) {
    throw new Error(`Could not reach instance "${instance.name}" at ${instance.origin_url}: ${error.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(body.error || `Instance "${instance.name}" returned ${res.status}.`), {
      status: res.status,
    });
  }
  return body;
}

export async function pingHealth(originUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${originUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const body = await res.json().catch(() => ({}));
    return body.ok === true;
  } catch {
    return false;
  }
}
