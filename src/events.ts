import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import type { PRInfo, StampedEvent, TrialEvent, TrialSource, Verdict } from "./types";

/** Public trials are committed as demo replays; private-repo trials stay in gitignored data/. */
export const PUBLIC_RECORDINGS = "recordings";
export const PRIVATE_RECORDINGS = "data/recordings";
mkdirSync(PUBLIC_RECORDINGS, { recursive: true });
mkdirSync(PRIVATE_RECORDINGS, { recursive: true });

type Listener = (e: StampedEvent) => void;

/** Buffered per-trial event bus: late subscribers get the full history, then live events. Persistence is injected. */
export class TrialBus {
  readonly events: StampedEvent[] = [];
  private listeners = new Set<Listener>();
  private start = Date.now();
  closed = false;

  constructor(
    readonly id: string,
    private persist: (e: StampedEvent) => void,
  ) {}

  emit = (e: TrialEvent) => {
    const stamped = { ...e, ts: Date.now() - this.start } as StampedEvent;
    this.events.push(stamped);
    // Speech/code deltas are high-volume; they are still recorded so replays look identical.
    this.persist(stamped);
    for (const l of this.listeners) l(stamped);
    if (e.t === "trial_end") this.closed = true;
  };

  subscribe(l: Listener): () => void {
    for (const e of this.events) l(e);
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export interface TrialSummary {
  id: string;
  pr: PRInfo | null;
  status: "in_session" | "BROKEN" | "UPHELD" | "INCONCLUSIVE" | "error";
  headline?: string;
  startedAt?: number;
  requestedBy?: string;
  source?: TrialSource;
  visibility: "public" | "private";
}

export function readRecording(id: string): StampedEvent[] | null {
  if (!/^[\w-]+$/.test(id)) return null;
  for (const dir of [PUBLIC_RECORDINGS, PRIVATE_RECORDINGS]) {
    const path = `${dir}/${id}.jsonl`;
    if (!existsSync(path)) continue;
    const events: StampedEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // The last line can be partial while a trial is still appending to the file.
      }
    }
    return events.length ? events : null;
  }
  return null;
}

export function summarize(id: string, events: StampedEvent[], live: boolean): TrialSummary {
  let pr: PRInfo | null = null;
  let meta: Partial<TrialSummary> = {};
  let verdict: Verdict | null = null;
  let errored = false;
  for (const e of events) {
    if (e.t === "trial_start") {
      pr = e.pr;
      meta = { startedAt: e.startedAt, requestedBy: e.requestedBy, source: e.source, visibility: e.visibility };
    }
    if (e.t === "verdict") verdict = e.verdict;
    if (e.t === "error") errored = true;
  }
  const ended = events.some((e) => e.t === "trial_end");
  const status = verdict ? verdict.ruling : errored && ended ? "error" : live && !ended ? "in_session" : "error";
  // Fail closed: anything from a private repo is private even if the event predates the visibility field.
  const visibility = meta.visibility === "private" || pr?.private ? "private" : "public";
  return { id, pr, status, headline: verdict?.headline, ...meta, visibility };
}

/** Public trials are visible to everyone; private-repo trials only to the user who ran them. */
export function canView(summary: TrialSummary, login: string | undefined): boolean {
  return summary.visibility === "public" || (Boolean(login) && summary.requestedBy === login);
}

export function listRecordings(): string[] {
  return [PUBLIC_RECORDINGS, PRIVATE_RECORDINGS].flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, "")),
  );
}
