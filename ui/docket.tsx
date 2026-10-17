import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/space-grotesk/latin-400.css";
import "@fontsource/space-grotesk/latin-500.css";
import "@fontsource/space-grotesk/latin-600.css";
import "@fontsource/crimson-text/latin-400.css";
import "@fontsource/crimson-text/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import { Shell, useHealth } from "./shell.tsx";

type Row = {
  id: string;
  pr: { title: string; owner: string; repo: string; number: number };
  status: "in_session" | "BROKEN" | "UPHELD" | "INCONCLUSIVE" | "error";
  headline?: string;
  startedAt?: number;
};

const LABEL: Record<Row["status"], string> = {
  BROKEN: "Broken",
  UPHELD: "Upheld",
  INCONCLUSIVE: "Inconclusive",
  in_session: "In session",
  error: "Mistrial",
};

function timeLabel(stamp?: number) {
  if (!stamp) return "";
  return new Date(stamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Docket() {
  const health = useHealth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const next = (await fetch("/api/trials").then((res) => res.json())) as Row[];
        if (!stop) setRows(Array.isArray(next) ? next : []);
      } catch {
        if (!stop) setRows([]);
      }
    };
    load();
    const id = setInterval(load, 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  const count = (status: Row["status"]) => rows?.filter((row) => row.status === status).length ?? 0;

  async function summon(event: FormEvent) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const res = await fetch("/api/trials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl: url }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error || "The court did not accept that pull request.");
      location.href = `/trial/${data.id}`;
    } catch (caught) {
      setPending(false);
      setError(caught instanceof Error ? caught.message : "The court did not accept that pull request.");
    }
  }

  const counts = [
    ["broken", count("BROKEN")],
    ["upheld", count("UPHELD")],
    ["inconclusive", count("INCONCLUSIVE")],
    ["in session", count("in_session")],
  ] as const;

  return (
    <Shell health={health.text} ready={health.ready}>
      <main className="min-h-0 flex-1 overflow-auto px-5 py-8 sm:px-10 sm:py-12">
        <div className="mx-auto flex w-full max-w-3xl flex-col">
          <h1 className="max-w-[16ch] text-[2.5rem] leading-[1.05] font-medium tracking-[-0.03em]">
            Place a pull request on the desk.
          </h1>
          <p className="mt-5 max-w-[62ch] font-serif text-[1.175rem] leading-relaxed text-ink">
            Prosecution and defense each run in a micro-VM. The judge rules on exit codes, timings, and output.
          </p>

          <form onSubmit={summon} className="mt-10">
            <div className="composer flex h-14 items-center rounded-[6px] border border-line bg-surface focus-within:border-phosphor">
              <label className="sr-only" htmlFor="prUrl">
                Pull request URL
              </label>
              <input
                id="prUrl"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  if (error) setError("");
                }}
                placeholder="https://github.com/owner/repo/pull/123"
                autoComplete="off"
                spellCheck={false}
                required
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "summon-error" : undefined}
                className="h-full min-w-0 flex-1 bg-transparent px-4 font-mono text-[14px] text-ink outline-none placeholder:text-muted"
              />
              <button
                type="submit"
                disabled={pending}
                className="mr-1.5 h-11 shrink-0 rounded-[6px] bg-ink px-5 text-[14px] font-medium text-canvas enabled:hover:bg-[#d4d4d4] disabled:cursor-wait disabled:opacity-50"
              >
                {pending ? "Summoning" : "Summon"}
              </button>
            </div>
            {error ? (
              <p id="summon-error" role="alert" className="mt-3 max-w-[68ch] text-[14px] leading-relaxed text-ink">
                {error} Use a link like https://github.com/owner/repo/pull/123.
              </p>
            ) : null}
          </form>

          <section className="mt-14" aria-label="Trials">
            <p className="font-mono text-[13px] text-muted tabular-nums">
              {counts.map(([label, value], index) => (
                <span key={label}>
                  {index > 0 ? <span className="mx-3 text-line">/</span> : null}
                  <span className={label === "in session" && value > 0 ? "text-phosphor" : "text-ink"}>{value}</span> {label}
                </span>
              ))}
            </p>
            <div className="mt-3 border-t border-line">
              {rows === null ? (
                <p className="py-6 text-[15px] text-muted">Loading the docket.</p>
              ) : rows.length === 0 ? (
                <p className="max-w-[62ch] py-6 text-[15px] leading-relaxed text-muted">
                  No trials yet. Paste a pull request URL above, or open one on a repository that sends webhooks here.
                </p>
              ) : (
                <ul>
                  {rows.map((row) => (
                    <li key={row.id} className="border-b border-line">
                      <a
                        href={`/trial/${row.id}`}
                        className="grid grid-cols-1 items-baseline gap-x-4 gap-y-1 py-3.5 no-underline hover:bg-raise sm:grid-cols-[7.25rem_minmax(0,1fr)_auto] sm:px-2"
                      >
                        <span className={`font-mono text-[12px] ${row.status === "in_session" ? "text-phosphor" : "text-muted"}`}>
                          {LABEL[row.status] ?? row.status}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[15px] font-medium tracking-[-0.01em]">{row.pr.title}</span>
                          <span className="mt-0.5 block truncate font-mono text-[12px] text-muted">
                            {row.pr.owner}/{row.pr.repo} #{row.pr.number}
                            {row.headline ? ` · ${row.headline}` : ""}
                          </span>
                        </span>
                        <span className="font-mono text-[12px] text-muted tabular-nums">{timeLabel(row.startedAt)}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </main>
    </Shell>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Docket />);
