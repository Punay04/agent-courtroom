import { useEffect, useState, type ReactNode } from "react";

export function useHealth() {
  const [text, setText] = useState("Checking the desk");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const health = await fetch("/api/health").then((res) => res.json());
        if (stop) return;
        if (health.missing?.length) {
          setReady(false);
          setText(`Missing ${health.missing.join(", ")}`);
          return;
        }
        setReady(true);
        const github = health.githubWrite ? "GitHub connected" : "GitHub read only";
        setText(`${health.models.counsel} · judge ${health.models.judge} · ${github}`);
      } catch {
        if (!stop) {
          setReady(false);
          setText("Server offline");
        }
      }
    };
    tick();
    const id = setInterval(tick, 15000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  return { text, ready };
}

export function Shell({
  health,
  ready,
  inert,
  children,
}: {
  health: string;
  ready: boolean;
  inert?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex h-dvh bg-canvas text-ink" inert={inert || undefined}>
      <a
        href="#desk"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:bg-ink focus:px-3 focus:py-2 focus:text-canvas"
      >
        Skip to the desk
      </a>
      <aside className="hidden w-[232px] shrink-0 flex-col justify-between border-r border-line bg-surface p-6 md:flex">
        <div>
          <a href="/" className="block text-[1.35rem] leading-none font-medium tracking-[-0.03em] text-ink">
            Agent Courtroom
          </a>
          <p className="mt-6 max-w-[18ch] font-serif text-[1.125rem] leading-snug text-ink">
            Two sandboxes argue. The judge counts what actually ran.
          </p>
        </div>
        <p className="flex items-start gap-2 font-mono text-[12px] leading-relaxed text-muted">
          <span className={`mt-1 size-1.5 shrink-0 ${ready ? "bg-phosphor" : "bg-trace"}`} />
          <span>{health}</span>
        </p>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-line px-4 py-3 md:hidden">
          <a href="/" className="text-[15px] font-medium tracking-[-0.03em]">
            Agent Courtroom
          </a>
          <span className={`size-1.5 ${ready ? "bg-phosphor" : "bg-trace"}`} title={health} />
        </header>
        <div id="desk" className="flex min-h-0 flex-1 flex-col">
          {children}
        </div>
      </div>
    </div>
  );
}
