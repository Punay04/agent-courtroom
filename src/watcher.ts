import { allSessions, saveSessions, type Session } from "./auth";
import { config } from "./config";
import { github, parsePrUrl } from "./github";
import { findTrial, summon } from "./trial";

/**
 * Auto-trial: every POLL_INTERVAL_SEC, look up each signed-in user's open PRs (any repo their token can see)
 * and put new PRs, or new commits on existing PRs, on trial. Results stay in the UI; nothing is posted to GitHub.
 */
export function startWatcher(): void {
  setTimeout(tick, 5_000);
  setInterval(tick, config.pollIntervalSec * 1000);
}

let ticking = false;
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const s of allSessions()) {
      if (!s.autoTrial) continue;
      await watchUser(s).catch((e) => console.warn(`[watcher] ${s.login}:`, e?.message ?? e));
    }
  } finally {
    ticking = false;
  }
}

async function watchUser(s: Session): Promise<void> {
  const client = github(s.token);
  const prs = await client.searchMyOpenPRs(s.login);
  const w = s.watch;

  // First look after sign-in: remember what already exists so old PRs don't flood the queue.
  if (!w.baselined) {
    for (const p of prs) w.seen[p.html_url] = p.updated_at;
    w.baselined = true;
    saveSessions();
    console.log(`[watcher] ${s.login}: watching ${prs.length} open PR(s); new PRs and new commits will be auto-tried`);
    return;
  }

  let changed = false;
  for (const p of prs) {
    if (p.draft || w.seen[p.html_url] === p.updated_at) continue;
    w.seen[p.html_url] = p.updated_at;
    changed = true;

    const { owner, repo, number } = parsePrUrl(p.html_url);
    const pr = await client.getPR(owner, repo, number);
    // updated_at also moves on comments and labels; only a new head commit earns a new trial.
    if (w.tried[p.html_url] === pr.head_sha || findTrial(pr.html_url, pr.head_sha, s.login)) continue;

    const hourAgo = Date.now() - 3_600_000;
    w.autoRuns = w.autoRuns.filter((t) => t > hourAgo);
    if (w.autoRuns.length >= config.maxAutoTrialsPerHour) {
      console.warn(`[watcher] ${s.login}: hourly auto-trial cap (${config.maxAutoTrialsPerHour}) reached; skipping ${p.html_url}`);
      continue;
    }
    w.autoRuns.push(Date.now());
    w.tried[p.html_url] = pr.head_sha;
    const t = await summon(p.html_url, { gh: client, requestedBy: s.login, source: "auto", publish: false, pr });
    console.log(`[watcher] ${s.login}: auto-trial ${t.id} for ${p.html_url} @ ${pr.head_sha.slice(0, 7)}`);
  }
  if (changed) saveSessions();
}
