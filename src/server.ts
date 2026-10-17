import { existsSync } from "node:fs";
import { normalize } from "node:path";
import docketPage from "../ui/docket.html";
import courtroomPage from "../ui/trial.html";
import { config, missingConfig } from "./config";
import { reapOrphans } from "./courthouse";
import { listRecordings, readRecording, summarize } from "./events";
import { canWrite, verifySignature } from "./github";
import { getTrial, liveTrials, summon, trialUrl } from "./trial";
import type { StampedEvent } from "./types";

const styles = Bun.spawn([process.execPath, "x", "@tailwindcss/cli", "-i", "ui/app.css", "-o", "ui/compiled.css"], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await styles.exited) !== 0) console.warn("Tailwind did not compile. The desk will load without its styles.");

const json = (data: unknown, status = 200) => Response.json(data, { status });

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

function trialEvents(id: string, req: Request): Response {
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
  const recorded = readRecording(id);
  if (!recorded) return json({ error: "no such trial" }, 404);
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

function listAll() {
  const seen = new Set<string>();
  const rows = liveTrials().map((t) => {
    seen.add(t.id);
    return summarize(t.id, t.bus.events, true);
  });
  for (const id of listRecordings()) {
    if (seen.has(id)) continue;
    const events = readRecording(id);
    if (events?.length) rows.push(summarize(id, events, false));
  }
  return rows.filter((r) => r.pr).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
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
  const t = await summon(prUrl);
  return json({ id: t.id, url: trialUrl(t.id) }, 202);
}

function serveStatic(pathname: string): Response {
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const path = `public${rel}`;
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(path));
}

const server = Bun.serve({
  port: config.port,
  idleTimeout: 255, // SSE streams outlive Bun's 10 s default; we also ping every 15 s.
  routes: {
    "/": docketPage,
    "/trial/:id": courtroomPage,
  },
  development: {
    hmr: true,
    console: true,
  },
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/api/health")
        return json({ missing: missingConfig(), githubWrite: canWrite(), publicUrl: config.publicUrl, models: { counsel: config.counselModel, judge: config.judgeModel } });
      if (req.method === "GET" && path === "/api/trials") return json(listAll());
      if (req.method === "POST" && path === "/api/trials") {
        const { prUrl } = (await req.json()) as { prUrl?: string };
        if (!prUrl) return json({ error: "prUrl required" }, 400);
        const t = await summon(prUrl);
        return json({ id: t.id, url: trialUrl(t.id) }, 201);
      }
      const m = path.match(/^\/api\/trials\/([\w-]+)\/events$/);
      if (req.method === "GET" && m) return trialEvents(m[1]!, req);
      if (req.method === "POST" && path === "/api/github/webhook") return await webhook(req);
      if (req.method === "GET" && path === "/ui/compiled.css") {
        return new Response(Bun.file("ui/compiled.css"), {
          headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" },
        });
      }
      if (req.method === "GET" && path.startsWith("/public/")) return serveStatic(path.slice("/public".length));
      return new Response("not found", { status: 404 });
    } catch (e: any) {
      console.error(`[server] ${req.method} ${path}:`, e);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  },
});

console.log(`⚖️  Agent Courtroom listening on http://localhost:${server.port}  (public: ${config.publicUrl})`);
const missing = missingConfig();
if (missing.length) console.warn(`⚠️  Missing env: ${missing.join(", ")}. Trials will fail until these are set in .env`);
if (!canWrite()) console.warn("⚠️  GITHUB_TOKEN not set: PR comments and statuses are disabled (public PRs can still be tried).");
if (process.env.CREATEOS_SANDBOX_API_KEY) {
  reapOrphans()
    .then((n) => n && console.log(`🧹 reaped ${n} orphaned court-* sandbox(es)`))
    .catch((e) => console.warn("[courthouse] reap failed:", e?.message ?? e));
}
