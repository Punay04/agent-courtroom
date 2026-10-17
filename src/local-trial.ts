// bun src/local-trial.ts <repo-dir> <base-ref> <head-ref> "<PR title>" ["<PR body>"]
// Runs a full trial on a local git repo (no GitHub needed) and records it for replay at /trial/<id>.
import { config } from "./config";
import { TrialBus } from "./events";
import { conductTrial, logToConsole } from "./trial";
import type { PRInfo } from "./types";

const [repo, baseRef, headRef, title, body = ""] = process.argv.slice(2);
if (!repo || !baseRef || !headRef || !title) {
  console.error('usage: bun src/local-trial.ts <repo-dir> <base-ref> <head-ref> "<PR title>" ["<PR body>"]');
  process.exit(1);
}

const repoPath = repo.replace(/[\\/]+$/, "");

const git = async (...args: string[]) => {
  const proc = Bun.spawn(["git", "-C", repoPath, ...args], { stdout: "pipe", stderr: "pipe" });
  // Read both pipes together. Waiting on stdout before stderr deadlocks once the stderr buffer fills.
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // `git diff` exits 1 when there are differences if --exit-code is set, or on some builds by default.
  const diffWithChanges = args[0] === "diff" && code === 1;
  if (code !== 0 && !diffWithChanges) throw new Error(`git ${args.join(" ")} failed: ${err.trim() || `exit ${code}`}`);
  return out;
};
const text = async (...args: string[]) => new TextDecoder().decode(await git(...args)).trim();
const tarball = (ref: string) => git("archive", "--format=tar.gz", `--prefix=src-${ref.replace(/\W/g, "-")}/`, ref);

const [baseSha, headSha, diff, base, head] = await Promise.all([
  text("rev-parse", baseRef),
  text("rev-parse", headRef),
  text("diff", `${baseRef}...${headRef}`),
  tarball(baseRef),
  tarball(headRef),
]);

const name = repoPath.split(/[\\/]/).pop() || "repo";
const pr: PRInfo = {
  owner: "local",
  repo: name,
  number: 0,
  title,
  body,
  author: "local",
  html_url: `file://${repoPath.replace(/\\/g, "/").replace(/^(?!\/)/, "/")}#${headRef}`,
  head_sha: headSha,
  base_sha: baseSha,
  head_ref: headRef,
  base_ref: baseRef,
};

// The old 4-char timestamp suffix repeats about every 28 minutes and TrialBus appends,
// so a second run of the same branch would concatenate two trials into one recording.
const id = `local-${headRef.replace(/\W+/g, "-")}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const bus = new TrialBus(id);
bus.subscribe(logToConsole(id));
bus.emit({ t: "trial_start", id, pr, startedAt: Date.now() });
try {
  await conductTrial(id, pr, { diff, base, head }, bus.emit);
} catch (e: any) {
  bus.emit({ t: "error", message: String(e?.message ?? e) });
} finally {
  bus.emit({ t: "trial_end" });
}
console.log(`\nRecorded. Watch the replay at ${config.publicUrl}/trial/${id}`);
