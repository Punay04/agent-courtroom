import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "./config";
import { github } from "./github";
import { store, type SessionRow } from "./store";

export interface WatchState {
  baselined: boolean;
  /** PR url -> last seen updated_at */
  seen: Record<string, string>;
  /** PR url -> last head sha put on trial */
  tried: Record<string, string>;
  /** timestamps of recent auto-trials, for the hourly cap */
  autoRuns: number[];
}

export interface Session {
  id: string;
  login: string;
  name: string | null;
  avatar_url: string;
  token: string;
  createdAt: number;
  autoTrial: boolean;
  watch: WatchState;
}

const SCOPES = "repo read:user";
const MONTH = 30 * 24 * 3600;
const sessions = new Map<string, Session>();

export const authEnabled = () => Boolean(config.githubClientId && config.githubClientSecret && config.sessionSecret);

// ---------- encrypted persistence (AES-256-GCM, key derived from SESSION_SECRET) ----------

const key = () => createHash("sha256").update(config.sessionSecret).digest();

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

function decrypt(blob: string): string {
  const raw = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

/** Session rows hold the OAuth token encrypted; the rest is plain so Postgres can be inspected. */
const toRow = (x: Session): SessionRow => ({
  id: x.id,
  login: x.login,
  name: x.name,
  avatar_url: x.avatar_url,
  token_enc: encrypt(x.token),
  auto_trial: x.autoTrial,
  watch: x.watch,
});

let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function saveSessions(): void {
  if (!authEnabled()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.saveSessions([...sessions.values()].map(toRow)).catch((e) => console.warn("[auth] saving sessions failed:", e?.message ?? e));
  }, 200);
}

/** Restore sessions at boot (call before serving). */
export async function initSessions(): Promise<void> {
  if (!authEnabled()) return;
  for (const r of await store.loadSessions()) {
    try {
      sessions.set(r.id, {
        id: r.id,
        login: r.login,
        name: r.name,
        avatar_url: r.avatar_url,
        token: decrypt(r.token_enc),
        createdAt: Date.now(),
        autoTrial: r.auto_trial,
        watch: { baselined: false, seen: {}, tried: {}, autoRuns: [], ...(r.watch as Partial<WatchState>) },
      });
    } catch {
      console.warn(`[auth] could not decrypt session for ${r.login} (SESSION_SECRET changed?); they will need to sign in again`);
    }
  }
  if (sessions.size) console.log(`🔑 restored ${sessions.size} session(s) from ${store.kind}`);
}

export const allSessions = () => [...sessions.values()];

// ---------- cookies ----------

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isHttps = (req: Request) =>
  (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")) === "https" ||
  config.publicUrl.startsWith("https://");

function cookie(req: Request, name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
}

export function currentUser(req: Request): Session | null {
  const sid = cookies(req).sid;
  return (sid && sessions.get(sid)) || null;
}

// ---------- OAuth flow ----------

const callbackUrl = () => `${config.publicUrl}/auth/github/callback`;

export function loginRedirect(req: Request): Response {
  const state = randomBytes(16).toString("hex");
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.githubClientId);
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  const headers = new Headers({ Location: url.toString() });
  headers.append("Set-Cookie", cookie(req, "oauth_state", state, 600));
  return new Response(null, { status: 302, headers });
}

export async function oauthCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = cookies(req).oauth_state;
  if (!code || !state || !expected || state !== expected) {
    return new Response("Sign-in failed: invalid or expired state. Go back and try again.", { status: 400 });
  }

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
      redirect_uri: callbackUrl(),
    }),
  });
  const tok = (await res.json()) as { access_token?: string; error_description?: string };
  if (!tok.access_token) return new Response(`Sign-in failed: ${tok.error_description ?? "no token"}`, { status: 400 });

  const user = await github(tok.access_token).getUser();
  // One session per GitHub login: re-signing in replaces the old token but keeps watch state.
  const previous = allSessions().find((s) => s.login === user.login);
  if (previous) {
    sessions.delete(previous.id);
    await store.deleteSession(previous.id).catch(() => {});
  }
  const session: Session = {
    id: randomBytes(24).toString("base64url"),
    login: user.login,
    name: user.name,
    avatar_url: user.avatar_url,
    token: tok.access_token,
    createdAt: Date.now(),
    autoTrial: previous?.autoTrial ?? true,
    watch: previous?.watch ?? { baselined: false, seen: {}, tried: {}, autoRuns: [] },
  };
  sessions.set(session.id, session);
  saveSessions();
  console.log(`🔑 ${user.login} signed in`);

  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", cookie(req, "sid", session.id, MONTH));
  headers.append("Set-Cookie", cookie(req, "oauth_state", "", 0));
  return new Response(null, { status: 302, headers });
}

export function logout(req: Request): Response {
  const s = currentUser(req);
  if (s) {
    sessions.delete(s.id);
    store.deleteSession(s.id).catch((e) => console.warn("[auth] deleting session failed:", e?.message ?? e));
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", cookie(req, "sid", "", 0));
  return new Response(JSON.stringify({ ok: true }), { headers });
}
