import docketPage from "../ui/docket.html";
import courtroomPage from "../ui/trial.html";
import { currentUser, initSessions, loginRedirect, logout, oauthCallback, saveSessions, type Session } from "./auth";
import { authEnabled, config, missingConfig } from "./config";
import { reapOrphans } from "./courthouse";
import { canView, summarize, type TrialSummary } from "./events";
import { github, serverGitHub, verifySignature, type PullSummary } from "./github";
import { store } from "./store";
import { getTrial, liveTrials, summon, trialUrl } from "./trial";
import type { StampedEvent } from "./types";
import { startWatcher } from "./watcher";

const PRODUCTION = process.env.NODE_ENV === "production";

// The Docker build already produces ui/compiled.css, so production only compiles at boot if the file is missing.
if (!PRODUCTION || !(await Bun.file("ui/compiled.css").exists())) {
  const styles = Bun.spawn([process.execPath, "x", "@tailwindcss/cli", "-i", "ui/app.css", "-o", "ui/compiled.css"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await styles.exited) !== 0) console.warn("Tailwind did not compile. The desk will load without its styles.");
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const TRIAL_ALL_CAP = 10;

function sse(start: (send: (e: StampedEvent) => void, close: () => void) => () => void, signal: AbortSignal): Response {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const body = new ReadableStream({
    start(controller) {
      let closed = false;
      const write = (s: string) => {
        if (!closed) controller.enqueue(enc.encode(s));
      };
      const ping = setInterval(() => write(": ping\n\n"), 15_000);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        controller.close();
      };
      const stop = start((e) => write(`data: ${JSON.stringify(e)}\n\n`), close);
      cleanup = () => {
        closed = true;
        clearInterval(ping);
        stop();
      };
      signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}

/** Summary of one trial if the viewer may see it, else null (private trials 404 for everyone else). */
async function viewableSummary(id: string, me: Session | null): Promise<TrialSummary | null> {
  const live = getTrial(id);
  const summary = live ? summarize(id, live.bus.events, true) : await store.getSummary(id);
  return summary && canView(summary, me?.login) ? summary : null;
}

async function trialEvents(id: string, req: Request, me: Session | null): Promise<Response> {
  if (!(await viewableSummary(id, me))) return json({ error: "no such trial" }, 404);
  const live = getTrial(id);
  if (live) {
    return sse((send, close) => {
      let unsub = () => {};
      unsub = live.bus.subscribe((e) => {
        send(e);
        if (e.t === "trial_end") queueMicrotask(close);
      });
      return unsub;
    }, req.signal);
  }
  const recorded = await store.getEvents(id);
  if (!recorded?.length) return json({ error: "no events recorded for this trial" }, 404);
  const speed = Number(new URL(req.url).searchParams.get("speed") ?? 1) || 1;
  return sse((send, close) => {
    // Replay with original pacing, but compress long silent gaps (sandbox boot, deliberation).
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      if (i >= recorded.length) return close();
      const e = recorded[i]!;
      send(e);
      i++;
      const gap = i < recorded.length ? recorded[i]!.ts - e.ts : 0;
      timer = setTimeout(next, Math.min(Math.max(gap, 0), 1500) / speed);
    };
    next();
    return () => clearTimeout(timer);
  }, req.signal);
}

/** Live trials (from memory) overlaid on stored ones, filtered to what the viewer may see. */
function liveSummaries(me: Session | null): TrialSummary[] {
  return liveTrials()
    .map((t) => summarize(t.id, t.bus.events, true))
    .filter((r) => r.pr && canView(r, me?.login));
}

async function listAll(me: Session | null): Promise<TrialSummary[]> {
  const live = liveSummaries(me);
  const liveIds = new Set(live.map((r) => r.id));
  const stored = (await store.listTrials(me?.login)).filter((r) => !liveIds.has(r.id));
  return [...live, ...stored].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/** Attach the newest visible trial for each PR (by URL) so the UI can show a status chip. */
async function annotate(prs: PullSummary[], me: Session) {
  const latest = await store.latestForUrls(prs.map((p) => p.html_url), me.login);
  // Live trials are the newest by definition.
  for (const t of liveSummaries(me).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) if (t.pr) latest.set(t.pr.html_url, t);
  return prs.map((p) => {
    const t = latest.get(p.html_url);
    return { ...p, trial: t ? { id: t.id, status: t.status, headline: t.headline } : null };
  });
}

async function trialMany(urls: string[], me: Session) {
  const client = github(me.token);
  const ids: string[] = [];
  for (const url of urls.slice(0, TRIAL_ALL_CAP)) {
    const t = await summon(url, { gh: client, requestedBy: me.login, source: "ui", publish: false }).catch((e) => {
      console.warn(`[trial-all] ${url}:`, e?.message ?? e);
      return null;
    });
    if (t) ids.push(t.id);
  }
  return { queued: ids.length, ids, capped: urls.length > TRIAL_ALL_CAP };
}

async function webhook(req: Request): Promise<Response> {
  const body = await req.text();
  if (!verifySignature(body, req.headers.get("x-hub-signature-256"))) return json({ error: "bad signature" }, 401);
  const event = req.headers.get("x-github-event");
  const payload = JSON.parse(body);
  let prUrl: string | undefined;
  if (event === "pull_request" && ["opened", "synchronize", "reopened", "ready_for_review"].includes(payload.action)) {
    if (!payload.pull_request?.draft) prUrl = payload.pull_request.html_url;
  } else if (event === "issue_comment" && payload.action === "created" && payload.issue?.pull_request) {
    if (String(payload.comment?.body ?? "").trim().startsWith("/court")) prUrl = payload.issue.pull_request.html_url;
  }
  if (!prUrl) return json({ ignored: true, event, action: payload.action });
  // The trial belongs to whoever triggered it (the pusher, or the author of the /court comment); only they can open it here.
  const requestedBy: string | undefined = payload.sender?.login;
  const t = await summon(prUrl, { gh: serverGitHub, requestedBy, source: "webhook", publish: true });
  return json({ id: t.id, url: trialUrl(t.id) }, 202);
}

// Storage first: schema + crash recovery, then restore sessions so cookies keep working across restarts.
await store.init();
await initSessions();

const server = Bun.serve({
  port: config.port,
  idleTimeout: 255, // SSE streams outlive Bun's 10 s default; we also ping every 15 s.
  routes: {
    "/": docketPage,
    "/trial/:id": courtroomPage,
  },
  development: PRODUCTION ? false : { hmr: true, console: true },
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const me = currentUser(req);
    const needMe = () => json({ error: "sign in with GitHub first" }, 401);
    try {
      // ---- auth ----
      if (req.method === "GET" && path === "/auth/github/login") {
        if (!authEnabled()) return new Response("GitHub sign-in is not configured on this server.", { status: 503 });
        return loginRedirect(req);
      }
      if (req.method === "GET" && path === "/auth/github/callback") return await oauthCallback(req);
      if (req.method === "POST" && path === "/auth/logout") return logout(req);

      // ---- me ----
      if (req.method === "GET" && path === "/api/me") {
        if (!me) return json({ authEnabled: authEnabled() }, 401);
        return json({ login: me.login, name: me.name, avatar_url: me.avatar_url, autoTrial: me.autoTrial, authEnabled: true });
      }
      if (req.method === "POST" && path === "/api/me/settings") {
        if (!me) return needMe();
        const { autoTrial } = (await req.json()) as { autoTrial?: boolean };
        if (typeof autoTrial === "boolean") {
          me.autoTrial = autoTrial;
          saveSessions();
        }
        return json({ autoTrial: me.autoTrial });
      }
      if (req.method === "GET" && path === "/api/me/repos") {
        if (!me) return needMe();
        return json(await github(me.token).listRepos(Number(url.searchParams.get("page") ?? 1)));
      }
      if (req.method === "GET" && path === "/api/me/prs") {
        if (!me) return needMe();
        return json(await annotate(await github(me.token).searchMyOpenPRs(me.login), me));
      }
      if (req.method === "POST" && path === "/api/me/prs/trial-all") {
        if (!me) return needMe();
        const prs = await github(me.token).searchMyOpenPRs(me.login);
        return json(await trialMany(prs.filter((p) => !p.draft).map((p) => p.html_url), me));
      }
      const repoPulls = path.match(/^\/api\/repos\/([\w.-]+)\/([\w.-]+)\/pulls$/);
      if (req.method === "GET" && repoPulls) {
        if (!me) return needMe();
        return json(await annotate(await github(me.token).listPulls(repoPulls[1]!, repoPulls[2]!), me));
      }
      const repoTrialAll = path.match(/^\/api\/repos\/([\w.-]+)\/([\w.-]+)\/trial-all$/);
      if (req.method === "POST" && repoTrialAll) {
        if (!me) return needMe();
        const prs = await github(me.token).listPulls(repoTrialAll[1]!, repoTrialAll[2]!);
        return json(await trialMany(prs.filter((p) => !p.draft).map((p) => p.html_url), me));
      }

      // ---- trials ----
      if (req.method === "GET" && path === "/api/health")
        return json({
          missing: missingConfig(),
          githubWrite: serverGitHub.canWrite(),
          authEnabled: authEnabled(),
          publicUrl: config.publicUrl,
          models: { counsel: config.counselModel, judge: config.judgeModel },
          storage: store.kind,
        });
      if (req.method === "GET" && path === "/api/trials") return json(await listAll(me));
      if (req.method === "POST" && path === "/api/trials") {
        const { prUrl } = (await req.json()) as { prUrl?: string };
        if (!prUrl) return json({ error: "prUrl required" }, 400);
        // With sign-in on, a trial needs an owner: an anonymous one would be visible to nobody, its starter included.
        if (authEnabled() && !me) return json({ error: "Sign in with GitHub to put a pull request on trial." }, 401);
        // UI-started trials never post to GitHub. Signed-in users read with their own token (private repos OK).
        const t = me
          ? await summon(prUrl, { gh: github(me.token), requestedBy: me.login, source: "ui", publish: false })
          : await summon(prUrl, { gh: serverGitHub, source: "ui", publish: false });
        return json({ id: t.id, url: trialUrl(t.id) }, 201);
      }
      const trialMeta = path.match(/^\/api\/trials\/([\w-]+)$/);
      if (req.method === "GET" && trialMeta) {
        const s = await viewableSummary(trialMeta[1]!, me);
        return s ? json(s) : json({ error: "no such trial" }, 404);
      }
      const m = path.match(/^\/api\/trials\/([\w-]+)\/events$/);
      if (req.method === "GET" && m) return await trialEvents(m[1]!, req, me);
      if (req.method === "POST" && path === "/api/github/webhook") return await webhook(req);
      if (req.method === "GET" && path === "/ui/compiled.css") {
        return new Response(Bun.file("ui/compiled.css"), {
          headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" },
        });
      }
      return new Response("not found", { status: 404 });
    } catch (e: any) {
      console.error(`[server] ${req.method} ${path}:`, e?.message ?? e);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  },
});

console.log(`⚖️  Agent Courtroom listening on http://localhost:${server.port}  (public: ${config.publicUrl}, storage: ${store.kind})`);
const missing = missingConfig();
if (missing.length) console.warn(`⚠️  Missing env: ${missing.join(", ")}. Trials will fail until these are set in .env`);
if (!serverGitHub.canWrite()) console.warn("⚠️  GITHUB_TOKEN not set: webhook trials can't post PR comments and statuses.");
if (authEnabled()) {
  console.log(`🔑 GitHub sign-in enabled (callback ${config.publicUrl}/auth/github/callback); auto-trial every ${config.pollIntervalSec}s`);
  startWatcher();
} else {
  console.warn("⚠️  GitHub sign-in disabled: set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and SESSION_SECRET to enable it.");
}
if (process.env.CREATEOS_SANDBOX_API_KEY) {
  reapOrphans()
    .then((n) => n && console.log(`🧹 reaped ${n} sandbox(es) this server left behind`))
    .catch((e) => console.warn("[courthouse] reap failed:", e?.message ?? e));
}
