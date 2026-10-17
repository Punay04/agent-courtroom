import type { Exhibit, ExecResult, PRInfo, TestSummary, Verdict } from "./types";

const RULING_LABEL: Record<Verdict["ruling"], string> = {
  BROKEN: "CLAIM BROKEN ❌",
  UPHELD: "CLAIM UPHELD ✅",
  INCONCLUSIVE: "INCONCLUSIVE ⚠️",
};
const RECOMMENDATION: Record<Verdict["recommendation"], string> = {
  merge: "Merge",
  request_changes: "Request changes",
  needs_human_review: "Needs human review",
};

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 140);

function run(r: ExecResult | undefined): string {
  if (!r) return "—";
  if (r.timed_out) return "⏱️ TIMEOUT";
  return `${r.exit_code === 0 ? "✅" : "❌"} exit ${r.exit_code} · ${r.exec_ms} ms`;
}

function fence(code: string, lang: string): string {
  const f = code.includes("```") ? "~~~~" : "```";
  return `${f}${lang}\n${code}\n${f}`;
}

export function renderInSession(pr: PRInfo, url: string): string {
  return `## ⚖️ Agent Courtroom: court is in session

The prosecution is trying to break this PR and the defense is trying to prove it, each running code in its own isolated CreateOS micro-VM. The judge will rule on the execution evidence only.

**[▶ Watch the trial live](${url})**

<sub>Head \`${pr.head_sha.slice(0, 7)}\` vs base \`${pr.base_sha.slice(0, 7)}\`. This comment will be updated with the verdict.</sub>`;
}

export function renderVerdict(v: Verdict, exhibits: Exhibit[], tests: TestSummary[], url: string): string {
  const assessment = new Map(v.exhibit_assessments.map((a) => [a.exhibit_id, a]));
  const rows = exhibits
    .map((e) => {
      const base = e.results.find((r) => r.checkout === "base")?.result;
      const head = e.results.find((r) => r.checkout === "head")?.result;
      const a = assessment.get(e.id);
      const side = e.side === "prosecution" ? "🔴 Prosecution" : "🔵 Defense";
      const judged = a ? `${a.valid ? "✔ valid" : "✖ rejected"}: ${cell(a.note)}` : "—";
      const id = e.id === v.decisive_exhibit ? `**${e.id}** ⭐` : e.id;
      return `| ${id} | ${side} | ${cell(e.argument)} | ${run(base)} | ${run(head)} | ${judged} |`;
    })
    .join("\n");

  const decisive = exhibits.find((e) => e.id === v.decisive_exhibit);
  const repro = decisive
    ? `\n<details><summary>🔁 Reproducer: Exhibit ${decisive.id}, exactly as executed</summary>\n\n${fence(decisive.code, decisive.language)}\n\nRun from the repo root: \`PYTHONPATH=. ${decisive.language === "python" ? "python3" : "bash"} repro.${decisive.language === "python" ? "py" : "sh"}\`\n</details>\n`
    : "";

  const blocking = v.blocking_issues.length
    ? `\n### Blocking issues\n${v.blocking_issues.map((b) => `- **${b.title}** (Exhibit ${b.exhibit_id})`).join("\n")}\n`
    : "";

  const suite = tests.map((t) => `${t.checkout}: ${t.passed} passed, ${t.failed} failed`).join(" · ");

  return `## ⚖️ Agent Courtroom: ${RULING_LABEL[v.ruling]}

> **${v.headline}**

**Recommendation:** ${RECOMMENDATION[v.recommendation]} · **Confidence:** ${v.confidence}${decisive ? ` · **Decisive evidence:** Exhibit ${decisive.id} (${decisive.side})` : ""}

${v.reasoning}
${blocking}
### Evidence
| Exhibit | Side | Purpose | base | head | Judge |
|---|---|---|---|---|---|
${rows || "| — | — | no exhibits filed | — | — | — |"}

<sub>Exhibit 0 (existing test suite): ${suite || "not run"}</sub>
${repro}
**[▶ Replay the full trial](${url})**

<sub>Agent Courtroom: the prosecutor and defender wrote and ran code in isolated CreateOS micro-VMs; the judge ruled on exit codes, timings and output only.</sub>`;
}

export function renderMistrial(message: string, url: string): string {
  return `## ⚖️ Agent Courtroom: mistrial

The court could not reach a verdict: \`${message.slice(0, 300)}\`

[View the trial log](${url}). Comment \`/court\` to retry.`;
}
