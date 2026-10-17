import { useEffect, useState, type ReactNode } from "react";

export type Me = { login: string; name: string | null; avatar_url: string; autoTrial: boolean };

/** Signed-in GitHub user (null when signed out); authEnabled is false when the server has no OAuth app configured. */
export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/me")
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok) setMe(data as Me);
        setAuthEnabled(Boolean(data.authEnabled));
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  return { me, authEnabled, loaded };
}

function Account() {
  const { me, authEnabled } = useMe();
  if (me) {
    return (
      <div className="flex items-center gap-2.5">
        <img src={me.avatar_url} alt="" className="size-7 rounded-full border border-line" />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium">@{me.login}</p>
          <button
            type="button"
            onClick={async () => {
              await fetch("/auth/logout", { method: "POST" });
              location.reload();
            }}
            className="font-mono text-[11px] text-muted hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }
  if (!authEnabled) return null;
  return (
    <a
      href="/auth/github/login"
      className="press inline-flex h-8 items-center gap-2 rounded-[7px] bg-phosphor px-3 text-[13px] font-medium text-phosphor-ink no-underline hover:bg-phosphor-hot"
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
      </svg>
      Sign in with GitHub
    </a>
  );
}

export function Shell({
  inert,
  children,
}: {
  inert?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col bg-canvas text-ink" inert={inert || undefined}>
      <a
        href="#desk"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:bg-ink focus:px-3 focus:py-2 focus:text-canvas"
      >
        Skip to the desk
      </a>
      <header className="chrome">
        <a href="/" className="shrink-0 font-sans text-[15px] leading-none font-semibold tracking-[-0.04em] text-ink no-underline">
          Agent Courtroom<span className="text-ink">.</span>
        </a>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <Account />
        </div>
      </header>
      <div id="desk" className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </div>
  );
}
