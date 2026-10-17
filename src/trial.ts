import type { Sandbox } from "@nodeops-createos/sandbox";
import { prepareSandbox, runTestSuite } from "./bailiff";
import { fileCharges } from "./clerk";
import { config } from "./config";
import { runCounsel, type CaseContext } from "./counsel";
import { createSandbox, destroySandbox } from "./courthouse";
import { TrialBus } from "./events";
import * as github from "./github";
import { deliberate } from "./judge";
import { renderInSession, renderMistrial, renderVerdict } from "./render";
import type { Exhibit, PRInfo, Role, StampedEvent, TestSummary, TrialEvent, Verdict } from "./types";

export interface TrialRecord {
  id: string;
  pr: PRInfo;
  bus: TrialBus;
  startedAt: number;
  verdict?: Verdict;
}

const trials = new Map<string, TrialRecord>();
let queue: Promise<void> = Promise.resolve();
let waiting = 0;

export const getTrial = (id: string) => trials.get(id);
export const liveTrials = () => [...trials.values()];
export const trialUrl = (id: string) => `${config.publicUrl}/trial/${id}`;

const newId = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6);

/** Open a trial for a PR and queue it. One trial runs at a time so sandbox usage stays bounded. */
export async function summon(prUrl: string): Promise<TrialRecord> {
  const { owner, repo, number } = github.parsePrUrl(prUrl);
  const pr = await github.getPR(owner, repo, number);
  for (const t of trials.values()) {
    if (t.pr.html_url === pr.html_url && t.pr.head_sha === pr.head_sha && !t.bus.closed) return t;
  }
  const id = newId();
  const bus = new TrialBus(id);
  bus.subscribe(logToConsole(id));
  const record: TrialRecord = { id, pr, bus, startedAt: Date.now() };
  trials.set(id, record);
  bus.emit({ t: "trial_start", id, pr, startedAt: record.startedAt });
  if (waiting > 0) bus.emit({ t: "status", message: `Waiting for the courtroom (${waiting} trial(s) ahead)…` });
  waiting++;
  queue = queue
    .then(() => runTrial(record))
    .catch((e) => console.error("[trial] queue error:", e))
    .finally(() => waiting--);
  return record;
}

async function runTrial(t: TrialRecord): Promise<void> {
  const { pr, bus } = t;
  const emit = bus.emit;
  const url = trialUrl(t.id);
  const status = (message: string) => emit({ t: "status", message });
  const warn = (what: string) => (e: any): undefined => {
    console.warn(`[github] ${what}:`, e?.message ?? e);
    return undefined;
  };
  let commentId: number | undefined;

  try {
    await github.setStatus(pr, "pending", "⚖️ Court is in session", url).catch(warn("status"));
    commentId = await github.upsertComment(pr, renderInSession(pr, url)).catch(warn("comment"));

    status("Fetching the diff and both checkouts from GitHub…");
    const [diff, base, head] = await Promise.all([
      github.getDiff(pr),
      github.getTarball(pr, pr.base_sha),
      github.getTarball(pr, pr.head_sha),
    ]);
    const { verdict, exhibits, tests } = await conductTrial(t.id, pr, { diff, base, head }, emit);
    t.verdict = verdict;

    await github.upsertComment(pr, renderVerdict(verdict, exhibits, tests, url), commentId).catch(warn("comment"));
    const desc =
      verdict.ruling === "INCONCLUSIVE" ? `Inconclusive: human review advised. ${verdict.headline}` : `${verdict.ruling}: ${verdict.headline}`;
    await github.setStatus(pr, verdict.ruling === "BROKEN" ? "failure" : "success", desc, url).catch(warn("status"));
  } catch (e: any) {
    const message = String(e?.message ?? e);
    console.error(`[trial ${t.id}] mistrial:`, e);
    emit({ t: "error", message });
    await github.upsertComment(pr, renderMistrial(message, url), commentId).catch(warn("comment"));
    await github.setStatus(pr, "error", `Mistrial: ${message}`, url).catch(warn("status"));
  } finally {
    emit({ t: "trial_end" });
  }
}

/** The court itself, independent of where the case came from: sandboxes, clerk, two rounds of counsel, judge. */
export async function conductTrial(
  id: string,
  pr: PRInfo,
  source: { diff: string; base: ArrayBuffer; head: ArrayBuffer },
  emit: (e: TrialEvent) => void,
): Promise<{ verdict: Verdict; exhibits: Exhibit[]; tests: TestSummary[] }> {
  const status = (message: string) => emit({ t: "status", message });
  const { diff, base, head } = source;
  let p: Sandbox | undefined;
  let d: Sandbox | undefined;
  try {
    const changedFiles = [...diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]!);
    const chargeSheet = fileCharges(pr, diff);
    // Sandbox setup can throw before this is awaited. A handler here keeps that rejection from crashing the process.
    void chargeSheet.catch(() => {});

    status("Summoning two CreateOS micro-VMs…");
    // CreateOS sandbox names max out at 22 chars.
    const sbName = (side: string) => `court-${id.slice(-12)}-${side}`;
    const created = await Promise.allSettled([createSandbox(sbName("p")), createSandbox(sbName("d"))]);
    p = created[0].status === "fulfilled" ? created[0].value : undefined;
    d = created[1].status === "fulfilled" ? created[1].value : undefined;
    if (!p || !d) {
      const why = created.map((c) => (c.status === "rejected" ? String(c.reason?.message ?? c.reason) : "")).filter(Boolean);
      throw new Error(`Could not create sandboxes: ${why.join("; ")}`);
    }
    status(`Sandboxes ready: prosecution ${p.id}, defense ${d.id}. Unpacking the case files and installing dependencies…`);
    const [prepP] = await Promise.all([prepareSandbox(p, { base, head }, changedFiles), prepareSandbox(d, { base, head }, changedFiles)]);
    const stack = prepP.stack;
    status(`Detected ${stack.kind}${stack.manager ? ` (${stack.manager})` : ""}. Running the existing tests on base and head (Exhibit 0: ${stack.testCommand ?? "no test command found"})…`);
    const tests = await Promise.all([runTestSuite(p, "base", stack), runTestSuite(d, "head", stack)]);
    emit({ t: "exhibit0", tests });

    const charge = await chargeSheet;
    emit({ t: "charge", sheet: charge });

    const ctx: CaseContext = { pr, diff, changedFiles, charge, tests, tools: prepP.tools, stack };
    const exhibits: Exhibit[] = [];
    const statements: { role: Role; round: number; statement: string }[] = [];
    const counters: Record<Role, number> = { prosecution: 0, defense: 0 };

    for (let round = 1; round <= config.rounds; round++) {
      const prior = [...exhibits];
      const argue = async (role: Role, sb: Sandbox) => {
        emit({ t: "turn_start", role, round });
        const r = await runCounsel({
          role,
          round,
          sb,
          ctx,
          prior,
          nextId: () => `${role === "prosecution" ? "P" : "D"}-${++counters[role]}`,
          emit,
        });
        emit({ t: "turn_end", role, round, statement: r.statement });
        return { role, ...r };
      };
      for (const r of await Promise.all([argue("prosecution", p), argue("defense", d)])) {
        exhibits.push(...r.exhibits);
        statements.push({ role: r.role, round, statement: r.statement });
      }
    }

    emit({ t: "deliberating" });
    const verdict = await deliberate({ pr, charge, tests, exhibits, statements });
    emit({ t: "verdict", verdict });
    return { verdict, exhibits, tests };
  } finally {
    await Promise.all([destroySandbox(p), destroySandbox(d)]);
  }
}

export function logToConsole(id: string) {
  const tag = (role: string) => (role === "prosecution" ? "\x1b[31mPROSECUTION\x1b[0m" : "\x1b[34mDEFENSE\x1b[0m");
  return (e: StampedEvent) => {
    const at = `[${id} +${(e.ts / 1000).toFixed(1)}s]`;
    switch (e.t) {
      case "trial_start":
        return console.log(`${at} ⚖️  ${e.pr.owner}/${e.pr.repo}#${e.pr.number} "${e.pr.title}"`);
      case "status":
        return console.log(`${at} ${e.message}`);
      case "charge":
        return console.log(`${at} CHARGE: ${e.sheet.summary}\n   criteria: ${e.sheet.falsifiable_criteria.join(" | ")}`);
      case "exhibit0":
        return console.log(`${at} EXHIBIT 0: ${e.tests.map((t) => `${t.checkout} ${t.passed}✓ ${t.failed}✗`).join(", ")}`);
      case "turn_start":
        return console.log(`${at} ${tag(e.role)} round ${e.round} begins`);
      case "inspect":
        return console.log(`${at} ${tag(e.role)} 🔍 ${e.command.slice(0, 120)}`);
      case "exhibit_start":
        return console.log(`${at} ${tag(e.role)} files ${e.id} [${e.checkout}]: ${e.argument}`);
      case "exhibit_result":
        return console.log(
          `${at} ${tag(e.role)} ${e.id} on ${e.checkout}: exit ${e.result.exit_code} in ${e.result.exec_ms}ms${e.result.timed_out ? " TIMEOUT" : ""}`,
        );
      case "turn_end":
        return console.log(`${at} ${tag(e.role)} rests: ${e.statement.slice(0, 300)}`);
      case "deliberating":
        return console.log(`${at} 🧑‍⚖️ judge is deliberating…`);
      case "verdict":
        return console.log(`${at} 🔨 VERDICT: ${e.verdict.ruling}: ${e.verdict.headline}\n   ${e.verdict.reasoning}`);
      case "error":
        return console.log(`${at} ❗ ${e.message}`);
      case "trial_end":
        return console.log(`${at} court adjourned`);
    }
  };
}
