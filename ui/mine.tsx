import { useEffect, useState } from "react";
import type { Me } from "./shell.tsx";

type Status = "in_session" | "BROKEN" | "UPHELD" | "INCONCLUSIVE" | "error";
type Pull = {
  number: number;
  title: string;
  html_url: string;
  author: string;
  updated_at: string;
  draft: boolean;
  repo: string;
  trial: { id: string; status: Status; headline?: string } | null;
};
type Repo = { full_name: string; private: boolean; description: string; language: string | null; pushed_at: string };

const LABEL: Record<Status, string> = {
  BROKEN: "Broken",
  UPHELD: "Upheld",
  INCONCLUSIVE: "Inconclusive",
  in_session: "In session",
  error: "Mistrial",
};

const button =
  "inline-flex h-8 shrink-0 items-center rounded-[7px] border border-line px-3 text-[13px] no-underline hover:border-edge hover:bg-hover hover:text-ink disabled:cursor-wait disabled:opacity-50";

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText);
  return data as T;
}

function PullRows({ pulls }: { pulls: Pull[] }) {
  const [busy, setBusy] = useState<string | null>(null);

  async function tryPull(url: string) {
    setBusy(url);
    try {
      const { id } = await api<{ id: string }>("/api/trials", { method: "POST", body: JSON.stringify({ prUrl: url }) });
      location.href = `/trial/${id}`;
    } catch (e) {
      setBusy(null);
      alert(e instanceof Error ? e.message : "The court did not accept that pull request.");
    }
  }

  return (
    <ul>
      {pulls.map((p) => (
        <li
          key={p.html_url}
          className="grid grid-cols-1 items-center gap-x-4 gap-y-1 border-b border-line py-3 sm:grid-cols-[7.25rem_minmax(0,1fr)_auto] sm:px-2"
        >
          {p.trial ? (
            <a href={`/trial/${p.trial.id}`} className={`font-mono text-[12px] no-underline ${p.trial.status === "in_session" ? "bg-phosphor px-1.5 py-0.5 text-phosphor-ink" : "text-ink"}`}>
              {LABEL[p.trial.status] ?? p.trial.status}
            </a>
          ) : (
            <span className="font-mono text-[12px] text-muted">Not tried</span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-medium tracking-[-0.01em]">
              {p.title}
              {p.draft ? <span className="ml-2 font-mono text-[11px] text-muted">draft</span> : null}
            </span>
            <span className="mt-0.5 block truncate font-mono text-[12px] text-muted">
              {p.repo} #{p.number} · {p.author} · {ago(p.updated_at)}
              {p.trial?.headline ? ` · ${p.trial.headline}` : ""}
            </span>
          </span>
          {p.trial?.status === "in_session" ? (
            <a href={`/trial/${p.trial.id}`} className={`${button} border-ink bg-phosphor text-phosphor-ink hover:bg-phosphor-hot`}>
              Watch live
            </a>
          ) : (
            <button type="button" className={button} disabled={busy === p.html_url} onClick={() => tryPull(p.html_url)}>
              {busy === p.html_url ? "Summoning" : p.trial ? "Re-try" : "Put on trial"}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function TrialAll({ path, label }: { path: string; label: string }) {
  const [text, setText] = useState(label);
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={button}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api<{ queued: number; capped: boolean }>(path, { method: "POST" });
          setText(`Queued ${r.queued}${r.capped ? " (first 10)" : ""}`);
        } catch (e) {
          alert(e instanceof Error ? e.message : "Could not queue trials.");
        } finally {
          setTimeout(() => {
            setBusy(false);
            setText(label);
          }, 3000);
        }
      }}
    >
      {text}
    </button>
  );
}

function MyPulls({ me }: { me: Me }) {
  const [pulls, setPulls] = useState<Pull[] | null>(null);
  const [error, setError] = useState("");
  const [auto, setAuto] = useState(me.autoTrial);

  useEffect(() => {
    let stop = false;
    const load = () =>
      api<Pull[]>("/api/me/prs")
        .then((next) => !stop && (setPulls(next), setError("")))
        .catch((e) => !stop && setError(e.message));
    load();
    const id = setInterval(load, 15000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 py-3">
        <label className="flex cursor-pointer items-center gap-2 text-[14px]">
          <input
            type="checkbox"
            checked={auto}
            onChange={async (e) => {
              const next = e.target.checked;
              setAuto(next);
              await api("/api/me/settings", { method: "POST", body: JSON.stringify({ autoTrial: next }) }).catch(() => setAuto(!next));
            }}
            className="size-4 accent-phosphor"
          />
          Auto-trial new PRs I open
          <span className="font-mono text-[12px] text-muted">new commits re-trigger</span>
        </label>
        <TrialAll path="/api/me/prs/trial-all" label="Run on all my open PRs" />
      </div>
      <div className="border-t border-line">
        {error ? (
          <p className="py-5 text-[14px] text-muted">Couldn't load your pull requests: {error}</p>
        ) : pulls === null ? (
          <p className="py-5 text-[14px] text-muted">Loading your open pull requests.</p>
        ) : pulls.length === 0 ? (
          <p className="max-w-[62ch] py-5 text-[14px] leading-relaxed text-muted">
            No open pull requests. Open one anywhere on GitHub and, with auto-trial on, the court convenes within a minute.
          </p>
        ) : (
          <PullRows pulls={pulls} />
        )}
      </div>
    </>
  );
}

function RepoRow({ repo }: { repo: Repo }) {
  const [open, setOpen] = useState(false);
  const [pulls, setPulls] = useState<Pull[] | null>(null);
  const [error, setError] = useState("");

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      setPulls(null);
      api<Pull[]>(`/api/repos/${repo.full_name}/pulls`)
        .then(setPulls)
        .catch((e) => setError(e.message));
    }
  }

  return (
    <li className="border-b border-line">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-3 py-3 text-left hover:bg-raise sm:px-2">
        <span className="w-[7.25rem] shrink-0 font-mono text-[12px] text-muted">{repo.private ? "Private" : "Public"}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium tracking-[-0.01em]">{repo.full_name}</span>
          <span className="mt-0.5 block truncate font-mono text-[12px] text-muted">
            {repo.language ? `${repo.language} · ` : ""}pushed {ago(repo.pushed_at)}
            {repo.description ? ` · ${repo.description}` : ""}
          </span>
        </span>
        <span className={`font-mono text-[12px] text-muted transition-transform ${open ? "rotate-90" : ""}`}>›</span>
      </button>
      {open ? (
        <div className="pb-3 sm:pl-[7.75rem]">
          {error ? (
            <p className="py-3 text-[14px] text-muted">Couldn't load pull requests: {error}</p>
          ) : pulls === null ? (
            <p className="py-3 text-[14px] text-muted">Loading open pull requests.</p>
          ) : pulls.length === 0 ? (
            <p className="py-3 text-[14px] text-muted">No open pull requests.</p>
          ) : (
            <>
              <div className="flex items-center justify-between py-2">
                <span className="font-mono text-[12px] text-muted">
                  {pulls.length} open pull request{pulls.length === 1 ? "" : "s"}
                </span>
                <TrialAll path={`/api/repos/${repo.full_name}/trial-all`} label="Try all open PRs" />
              </div>
              <div className="border-t border-line">
                <PullRows pulls={pulls} />
              </div>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

function MyRepos() {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    api<Repo[]>("/api/me/repos")
      .then(setRepos)
      .catch((e) => setError(e.message));
  }, []);

  const shown = (repos ?? []).filter((r) => !q || r.full_name.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="py-3">
        <label className="sr-only" htmlFor="repoFilter">
          Filter repositories
        </label>
        <input
          id="repoFilter"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter repositories"
          autoComplete="off"
          className="h-10 w-full rounded-[7px] border border-line bg-raise px-3 font-mono text-[13px] text-ink outline-none placeholder:text-muted focus:border-phosphor"
        />
      </div>
      <div className="border-t border-line">
        {error ? (
          <p className="py-5 text-[14px] text-muted">Couldn't load repositories: {error}</p>
        ) : repos === null ? (
          <p className="py-5 text-[14px] text-muted">Loading your repositories.</p>
        ) : shown.length === 0 ? (
          <p className="py-5 text-[14px] text-muted">No repositories match.</p>
        ) : (
          <ul>
            {shown.map((r) => (
              <RepoRow key={r.full_name} repo={r} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** Signed-in panel: the user's open PRs (with auto-trial) and their repositories (public and private). */
export function MyWork({ me }: { me: Me }) {
  const [tab, setTab] = useState<"prs" | "repos">("prs");
  const tabs = [
    ["prs", "My pull requests"],
    ["repos", "My repositories"],
  ] as const;

  return (
    <section className="mt-14" aria-label="Your work">
      <div className="flex gap-2">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={`inline-flex h-9 items-center rounded-[7px] border px-3 text-[13px] ${tab === id ? "border-phosphor bg-phosphor text-phosphor-ink" : "border-line text-muted hover:border-edge hover:bg-hover hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "prs" ? <MyPulls me={me} /> : <MyRepos />}
    </section>
  );
}
