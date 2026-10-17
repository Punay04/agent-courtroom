// bun src/local-trial.ts <repo-dir> <base-ref> <head-ref> "<PR title>" ["<PR body>"]
// Runs a full trial on a local git repo (no GitHub needed) and records it for replay at /trial/<id>.
import { TrialBus } from "./events";
import { conductTrial, logToConsole } from "./trial";
import type { PRInfo } from "./types";

const [repo, baseRef, headRef, title, body = ""] = process.argv.slice(2);
if (!repo || !baseRef || !headRef || !title) {
  console.error('usage: bun src/local-trial.ts <repo-dir> <base-ref> <head-ref> "<PR title>" ["<PR body>"]');
  process.exit(1);
}

const git = async (...args: string[]) => {
  const proc = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).arrayBuffer();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
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

const name = repo.replace(/\/$/, "").split("/").pop()!;
const pr: PRInfo = {
  owner: "local",
  repo: name,
  number: 0,
  title,
  body,
  author: "local",
  html_url: `file://${repo}#${headRef}`,
  head_sha: headSha,
  base_sha: baseSha,
  head_ref: headRef,
  base_ref: baseRef,
};

const id = `local-${headRef.replace(/\W+/g, "-")}-${Date.now().toString(36).slice(-4)}`;
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
console.log(`\nRecorded. Watch the replay at http://localhost:3000/trial/${id}`);
