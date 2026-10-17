import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import type { PRInfo, StampedEvent, TrialEvent, Verdict } from "./types";

const RECORDINGS = "recordings";
mkdirSync(RECORDINGS, { recursive: true });

type Listener = (e: StampedEvent) => void;

/** Buffered per-trial event bus: late subscribers get the full history, then live events. */
export class TrialBus {
  readonly events: StampedEvent[] = [];
  private listeners = new Set<Listener>();
  private start = Date.now();
  closed = false;

  constructor(readonly id: string) {}

  emit = (e: TrialEvent) => {
    const stamped = { ...e, ts: Date.now() - this.start } as StampedEvent;
    this.events.push(stamped);
    // Speech/code deltas are high-volume; they are still recorded so replays look identical.
    appendFileSync(`${RECORDINGS}/${this.id}.jsonl`, JSON.stringify(stamped) + "\n");
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
}

export function readRecording(id: string): StampedEvent[] | null {
  const path = `${RECORDINGS}/${id}.jsonl`;
  if (!/^[\w-]+$/.test(id) || !existsSync(path)) return null;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function summarize(id: string, events: StampedEvent[], live: boolean): TrialSummary {
  let pr: PRInfo | null = null;
  let startedAt: number | undefined;
  let verdict: Verdict | null = null;
  let errored = false;
  for (const e of events) {
    if (e.t === "trial_start") {
      pr = e.pr;
      startedAt = e.startedAt;
    }
    if (e.t === "verdict") verdict = e.verdict;
    if (e.t === "error") errored = true;
  }
  const ended = events.some((e) => e.t === "trial_end");
  const status = verdict ? verdict.ruling : errored && ended ? "error" : live && !ended ? "in_session" : "error";
  return { id, pr, status, headline: verdict?.headline, startedAt };
}

export function listRecordings(): string[] {
  return readdirSync(RECORDINGS)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""));
}
