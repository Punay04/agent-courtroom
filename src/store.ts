import { SQL } from "bun";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config";
import { PRIVATE_RECORDINGS, PUBLIC_RECORDINGS, canView, listRecordings, readRecording, summarize, type TrialSummary } from "./events";
import type { PRInfo, StampedEvent, TrialSource, Verdict } from "./types";

/** A persisted session. The OAuth token is stored encrypted (see auth.ts). */
export interface SessionRow {
  id: string;
  login: string;
  name: string | null;
  avatar_url: string;
  token_enc: string;
  auto_trial: boolean;
  watch: unknown;
}

export interface Store {
  readonly kind: "postgres" | "files";
  init(): Promise<void>;
  /** Persist one trial event. Fire-and-forget; writes are ordered per trial and batched. */
  record(id: string, isPrivate: boolean, e: StampedEvent): void;
  /** Wait until every recorded event has been written. */
  drain(): Promise<void>;
  /** Stored trial summaries the viewer may see (newest first). Live trials are overlaid by the server. */
  listTrials(login: string | undefined, limit?: number): Promise<TrialSummary[]>;
  getSummary(id: string): Promise<TrialSummary | null>;
  getEvents(id: string): Promise<StampedEvent[] | null>;
  /** Newest visible trial per PR URL. */
  latestForUrls(urls: string[], login: string | undefined): Promise<Map<string, TrialSummary>>;
  loadSessions(): Promise<SessionRow[]>;
  saveSessions(rows: SessionRow[]): Promise<void>;
  deleteSession(id: string): Promise<void>;
}

// ---------------------------------------------------------------- files (fallback when no DATABASE_URL)

const SESSIONS_FILE = "data/sessions.json";

class FileStore implements Store {
  readonly kind = "files" as const;

  async init() {}

  async drain() {}

  record(id: string, isPrivate: boolean, e: StampedEvent) {
    appendFileSync(`${isPrivate ? PRIVATE_RECORDINGS : PUBLIC_RECORDINGS}/${id}.jsonl`, JSON.stringify(e) + "\n");
  }

  async listTrials(login: string | undefined, limit = 200) {
    const rows: TrialSummary[] = [];
    for (const id of listRecordings()) {
      const events = readRecording(id);
      if (events?.length) rows.push(summarize(id, events, false));
    }
    return rows
      .filter((r) => r.pr && canView(r, login))
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, limit);
  }

  async getSummary(id: string) {
    const events = readRecording(id);
    return events?.length ? summarize(id, events, false) : null;
  }

  async getEvents(id: string) {
    return readRecording(id);
  }

  async latestForUrls(urls: string[], login: string | undefined) {
    const wanted = new Set(urls);
    const latest = new Map<string, TrialSummary>();
    for (const t of await this.listTrials(login, 10_000)) {
      if (t.pr && wanted.has(t.pr.html_url) && !latest.has(t.pr.html_url)) latest.set(t.pr.html_url, t);
    }
    return latest;
  }

  async loadSessions() {
    if (!existsSync(SESSIONS_FILE)) return [];
    try {
      const rows = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
      return Array.isArray(rows) ? (rows as SessionRow[]) : [];
    } catch {
      return [];
    }
  }

  async saveSessions(rows: SessionRow[]) {
    mkdirSync("data", { recursive: true });
    writeFileSync(SESSIONS_FILE, JSON.stringify(rows), { mode: 0o600 });
  }

  async deleteSession(id: string) {
    await this.saveSessions((await this.loadSessions()).filter((r) => r.id !== id));
  }
}

// ---------------------------------------------------------------- postgres

const json = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;

function rowToSummary(r: any): TrialSummary {
  return {
    id: r.id,
    pr: json<PRInfo>(r.pr),
    status: r.status,
    headline: r.headline ?? undefined,
    startedAt: r.started_at instanceof Date ? r.started_at.getTime() : new Date(r.started_at).getTime(),
    requestedBy: r.requested_by ?? undefined,
    source: (r.source ?? undefined) as TrialSource | undefined,
    visibility: r.visibility === "private" ? "private" : "public",
  };
}

class PgStore implements Store {
  readonly kind = "postgres" as const;
  private sql: SQL;
  private chains = new Map<string, Promise<unknown>>();
  private pending = new Map<string, { trial_id: string; seq: number; ts: number; event: string }[]>();
  private seqs = new Map<string, number>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(url: string) {
    this.sql = new SQL(url);
  }

  async init() {
    const sql = this.sql;
    await sql`create table if not exists trials (
      id           text primary key,
      pr           jsonb not null,
      pr_url       text not null,
      head_sha     text not null,
      requested_by text,
      source       text,
      visibility   text not null default 'public',
      status       text not null default 'in_session',
      errored      boolean not null default false,
      headline     text,
      verdict      jsonb,
      started_at   timestamptz not null default now(),
      ended_at     timestamptz
    )`;
    await sql`create index if not exists trials_started_idx on trials (started_at desc)`;
    await sql`create index if not exists trials_pr_url_idx on trials (pr_url, started_at desc)`;
    await sql`create table if not exists trial_events (
      trial_id text not null references trials(id) on delete cascade,
      seq      integer not null,
      ts       integer not null,
      event    text not null,
      primary key (trial_id, seq)
    )`;
    await sql`create table if not exists sessions (
      id         text primary key,
      login      text not null,
      name       text,
      avatar_url text,
      token_enc  text not null,
      auto_trial boolean not null default true,
      watch      jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    )`;
    // Trials only run inside a live server process; anything still "in session" was cut off by a restart.
    const stale = await sql`update trials set status = 'error', ended_at = now() where status = 'in_session' returning id`;
    if (stale.length) console.log(`[db] marked ${stale.length} interrupted trial(s) as mistrials`);
  }

  /** Run fn after every earlier write for this trial (keeps the trials row ahead of its events). */
  private enqueue(id: string, fn: () => Promise<unknown>) {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(fn).catch((e) => console.warn(`[db] trial ${id}:`, e?.message ?? e));
    this.chains.set(id, next);
    return next;
  }

  private async flushEvents(id: string) {
    const rows = this.pending.get(id);
    if (!rows?.length) return;
    this.pending.set(id, []);
    await this.sql`insert into trial_events ${this.sql(rows, "trial_id", "seq", "ts", "event")} on conflict do nothing`;
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      for (const id of this.pending.keys()) this.enqueue(id, () => this.flushEvents(id));
    }, 400);
  }

  record(id: string, isPrivate: boolean, e: StampedEvent) {
    const sql = this.sql;
    const seq = this.seqs.get(id) ?? 0;
    this.seqs.set(id, seq + 1);

    if (e.t === "trial_start") {
      const pr = e.pr;
      this.enqueue(
        id,
        () => sql`insert into trials (id, pr, pr_url, head_sha, requested_by, source, visibility, started_at)
          values (${id}, ${JSON.stringify(pr)}::jsonb, ${pr.html_url}, ${pr.head_sha}, ${e.requestedBy ?? null}, ${e.source ?? null},
                  ${isPrivate || pr.private ? "private" : "public"}, to_timestamp(${e.startedAt} / 1000.0))
          on conflict (id) do nothing`,
      );
    }

    if (!this.pending.has(id)) this.pending.set(id, []);
    this.pending.get(id)!.push({ trial_id: id, seq, ts: Math.round(e.ts), event: JSON.stringify(e) });

    if (e.t === "verdict") {
      const v: Verdict = e.verdict;
      this.enqueue(id, () => sql`update trials set status = ${v.ruling}, headline = ${v.headline}, verdict = ${JSON.stringify(v)}::jsonb where id = ${id}`);
    } else if (e.t === "error") {
      this.enqueue(id, () => sql`update trials set errored = true where id = ${id}`);
    }

    if (e.t === "trial_end") {
      this.enqueue(id, () => this.flushEvents(id));
      this.enqueue(
        id,
        () => sql`update trials set ended_at = now(), status = case when status = 'in_session' then 'error' else status end where id = ${id}`,
      ).then(() => {
        this.pending.delete(id);
        this.seqs.delete(id);
        this.chains.delete(id);
      });
    } else {
      this.scheduleFlush();
    }
  }

  async drain() {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    for (const id of this.pending.keys()) this.enqueue(id, () => this.flushEvents(id));
    while (this.chains.size) await Promise.all([...this.chains.values()]).then(() => this.chains.clear());
  }

  async listTrials(login: string | undefined, limit = 200) {
    const rows = await this.sql`
      select id, pr, status, headline, started_at, requested_by, source, visibility from trials
      where visibility = 'public' or requested_by = ${login ?? ""}
      order by started_at desc limit ${limit}`;
    return rows.map(rowToSummary);
  }

  async getSummary(id: string) {
    const [row] = await this.sql`select id, pr, status, headline, started_at, requested_by, source, visibility from trials where id = ${id}`;
    return row ? rowToSummary(row) : null;
  }

  async getEvents(id: string) {
    const rows = await this.sql`select event from trial_events where trial_id = ${id} order by seq`;
    return rows.length ? rows.map((r: any) => JSON.parse(r.event) as StampedEvent) : null;
  }

  async latestForUrls(urls: string[], login: string | undefined) {
    const latest = new Map<string, TrialSummary>();
    if (!urls.length) return latest;
    const rows = await this.sql`
      select distinct on (pr_url) id, pr, status, headline, started_at, requested_by, source, visibility from trials
      where pr_url = any(${this.sql.array(urls, "TEXT")})
        and (visibility = 'public' or requested_by = ${login ?? ""})
      order by pr_url, started_at desc`;
    for (const r of rows) {
      const s = rowToSummary(r);
      if (s.pr) latest.set(s.pr.html_url, s);
    }
    return latest;
  }

  async loadSessions() {
    const rows = await this.sql`select id, login, name, avatar_url, token_enc, auto_trial, watch from sessions`;
    return rows.map((r: any) => ({ ...r, watch: json(r.watch) }) as SessionRow);
  }

  async saveSessions(rows: SessionRow[]) {
    for (const r of rows) {
      await this.sql`insert into sessions (id, login, name, avatar_url, token_enc, auto_trial, watch, updated_at)
        values (${r.id}, ${r.login}, ${r.name}, ${r.avatar_url}, ${r.token_enc}, ${r.auto_trial}, ${JSON.stringify(r.watch)}::jsonb, now())
        on conflict (id) do update set login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url,
          token_enc = excluded.token_enc, auto_trial = excluded.auto_trial, watch = excluded.watch, updated_at = now()`;
    }
  }

  async deleteSession(id: string) {
    await this.sql`delete from sessions where id = ${id}`;
  }
}

export const store: Store = config.databaseUrl ? new PgStore(config.databaseUrl) : new FileStore();
