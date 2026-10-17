// Bun loads .env automatically.
const port = Number(process.env.PORT ?? 3000);

export const config = {
  port,
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ""),
  geminiKey: process.env.GEMINI_API_KEY ?? "",
  // Vertex AI express keys start with "AQ."; AI Studio keys start with "AIza".
  geminiBackend:
    process.env.GEMINI_BACKEND || ((process.env.GEMINI_API_KEY ?? "").startsWith("AQ.") ? "vertex" : "gemini"),
  githubToken: process.env.GITHUB_TOKEN ?? "",
  // Postgres for trials, events and sessions. Without it everything is stored in local files.
  databaseUrl: process.env.DATABASE_URL ?? "",
  // Cloud SQL on Cloud Run: /cloudsql/<PROJECT:REGION:INSTANCE>/.s.PGSQL.5432 (connects over the Unix socket).
  databaseSocketPath: process.env.DATABASE_SOCKET_PATH ?? "",
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  // "Sign in with GitHub" (OAuth App). Callback: PUBLIC_URL/auth/github/callback
  githubClientId: process.env.GITHUB_CLIENT_ID ?? "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
  sessionSecret: process.env.SESSION_SECRET ?? "",
  pollIntervalSec: Number(process.env.POLL_INTERVAL_SEC ?? 60),
  maxAutoTrialsPerHour: Number(process.env.MAX_AUTO_TRIALS_PER_HOUR ?? 10),
  maxConcurrentTrials: Number(process.env.MAX_CONCURRENT_TRIALS ?? 2),
  // Largest compressed source archive a trial downloads, per checkout. Each is held in memory for the whole trial,
  // so the server can hold 2 × MAX_CONCURRENT_TRIALS of them at once.
  maxRepoMb: Number(process.env.MAX_REPO_MB ?? 50),
  counselModel: process.env.COUNSEL_MODEL || "gemini-3.5-flash-lite",
  clerkModel: process.env.CLERK_MODEL || "gemini-3.5-flash-lite",
  judgeModel: process.env.JUDGE_MODEL || "gemini-3.8-flash",
  counselThinking: process.env.COUNSEL_THINKING ?? "low",
  stream: process.env.LLM_STREAM !== "0",
  shape: process.env.SANDBOX_SHAPE ?? "s-1vcpu-1gb",
  rootfs: process.env.SANDBOX_ROOTFS ?? "devbox:1",
  // Empty SANDBOX_EGRESS means allow-all (CreateOS semantics). Default: package registries only.
  egress: (
    process.env.SANDBOX_EGRESS ??
    "pypi.org:443,*.pythonhosted.org:443,registry.npmjs.org:443,registry.yarnpkg.com:443,proxy.golang.org:443,sum.golang.org:443,crates.io:443,*.crates.io:443"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  rounds: Number(process.env.ROUNDS ?? 2),
  maxExhibitsPerTurn: Number(process.env.MAX_EXHIBITS ?? 3),
  maxInspectsPerTurn: Number(process.env.MAX_INSPECTS ?? 8),
  exhibitTimeoutSec: Number(process.env.EXHIBIT_TIMEOUT ?? 30),
};

/** "Sign in with GitHub" is configured. With it on, every trial belongs to (and is visible only to) the account that started it. */
export const authEnabled = () => Boolean(config.githubClientId && config.githubClientSecret && config.sessionSecret);

export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!config.geminiKey) missing.push("GEMINI_API_KEY");
  if (!process.env.CREATEOS_SANDBOX_API_KEY) missing.push("CREATEOS_SANDBOX_API_KEY");
  return missing;
}
