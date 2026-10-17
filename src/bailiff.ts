import type { Sandbox } from "@nodeops-createos/sandbox";
import { exec, upload } from "./courthouse";
import type { Checkout, StackInfo, StackKind, TestSummary } from "./types";

// PEP 668 images refuse system-wide pip installs without PIP_BREAK_SYSTEM_PACKAGES.
const PIP = "PIP_BREAK_SYSTEM_PACKAGES=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_ROOT_USER_ACTION=ignore python3 -m pip install -q";

/** Non-interactive, colorless toolchains; Go fetches modules (and toolchains) only through the module proxy. */
export const ENV = "export CI=true NO_COLOR=1 FORCE_COLOR=0 CARGO_TERM_COLOR=never GOFLAGS=-mod=mod GOPROXY=https://proxy.golang.org;";

/** Shell prefix that enters a checkout with its sources importable. */
export const enter = (checkout: Checkout) =>
  `${ENV} cd /workspace/${checkout} && export PYTHONPATH=/workspace/${checkout}/src:/workspace/${checkout};`;

const EXT: [RegExp, StackKind][] = [
  [/\.py$/, "python"],
  [/\.(m?[jt]sx?|c[jt]s)$/, "node"],
  [/\.go$/, "go"],
  [/\.rs$/, "rust"],
  [/\.(c|cc|cpp|cxx|h|hpp)$/, "make"],
];
const PRIORITY: StackKind[] = ["python", "node", "go", "rust", "make"];

function nodeManager(files: Set<string>): { install: string; test: (script: boolean) => string | null; name: string } {
  if (files.has("bun.lock") || files.has("bun.lockb"))
    return { name: "bun", install: "bun install", test: (s) => (s ? "bun run test" : "bun test") };
  if (files.has("pnpm-lock.yaml"))
    return { name: "pnpm", install: "npx -y pnpm@9 install", test: (s) => (s ? "npx -y pnpm@9 test" : null) };
  if (files.has("yarn.lock"))
    return { name: "yarn", install: "npx -y yarn@1.22.22 install --non-interactive", test: (s) => (s ? "npx -y yarn@1.22.22 test" : null) };
  const install = files.has("package-lock.json")
    ? "npm ci --no-audit --no-fund || npm install --no-audit --no-fund"
    : "npm install --no-audit --no-fund";
  return { name: "npm", install, test: (s) => (s ? "npm test --silent" : null) };
}

/** Work out the repo's stack from marker files, weighted by which languages the PR actually touches. */
async function detectStack(sb: Sandbox, changedFiles: string[]): Promise<StackInfo & { installScript: string }> {
  const probe = await exec(
    sb,
    `cd /workspace/head
for f in requirements.txt pyproject.toml setup.py setup.cfg package.json bun.lock bun.lockb pnpm-lock.yaml yarn.lock package-lock.json go.mod Cargo.toml Makefile; do [ -e "$f" ] && echo "file:$f"; done
[ -f package.json ] && node -e 'const p=require("./package.json");const t=(p.scripts&&p.scripts.test)||"";console.log("nodetest:"+(/no test specified/.test(t)?"":t))' 2>/dev/null
[ -f Makefile ] && grep -qE "^test:" Makefile && echo "maketest:yes"
true`,
    { timeoutSec: 20 },
  );
  const lines = probe.stdout.split("\n");
  const files = new Set(lines.filter((l) => l.startsWith("file:")).map((l) => l.slice(5)));
  const nodeTestScript = lines.find((l) => l.startsWith("nodetest:"))?.slice(9).trim() ?? "";
  const makeTest = lines.includes("maketest:yes");

  const detected = new Set<StackKind>();
  if (["requirements.txt", "pyproject.toml", "setup.py", "setup.cfg"].some((f) => files.has(f))) detected.add("python");
  if (files.has("package.json")) detected.add("node");
  if (files.has("go.mod")) detected.add("go");
  if (files.has("Cargo.toml")) detected.add("rust");
  if (files.has("Makefile")) detected.add("make");

  // Score by the PR's changed files; a language with no marker file still counts (e.g. a bare Python package).
  const score = new Map<StackKind, number>();
  for (const f of changedFiles) {
    for (const [re, kind] of EXT) {
      if (re.test(f) && (detected.has(kind) || kind === "python" || kind === "node")) score.set(kind, (score.get(kind) ?? 0) + 1);
    }
  }
  const byScore = [...score.entries()].sort((a, b) => b[1] - a[1] || PRIORITY.indexOf(a[0]) - PRIORITY.indexOf(b[0]));
  const kind: StackKind = byScore[0]?.[0] ?? PRIORITY.find((k) => detected.has(k)) ?? "unknown";
  detected.add(kind);

  const both = (cmd: string) =>
    `(cd /workspace/base && ${cmd}) > /tmp/court/install-base.log 2>&1 & (cd /workspace/head && ${cmd}) > /tmp/court/install-head.log 2>&1 & wait; tail -4 /tmp/court/install-head.log`;

  // Python test tooling is always useful for exhibits, whatever the repo's language.
  const pyBase = `${PIP} pytest hypothesis 2>&1 | tail -2`;
  let installScript = pyBase;
  let testCommand: string | null = null;
  let framework = "none";
  let manager = "";

  if (kind === "python") {
    manager = "pip";
    installScript = [
      pyBase,
      `cd /workspace/head; for f in requirements*.txt requirements/*.txt; do [ -f "$f" ] && ${PIP} -r "$f" 2>&1 | tail -2; done`,
      `cd /workspace/head; if [ -f pyproject.toml ] || [ -f setup.py ]; then ${PIP} ".[test,tests,testing,dev]" 2>&1 | tail -2 || ${PIP} . 2>&1 | tail -2; fi`,
    ].join("; ");
    testCommand = "python3 -m pytest -q -p no:cacheprovider";
    framework = "pytest";
  } else if (kind === "node") {
    const m = nodeManager(files);
    manager = m.name;
    if (files.has("package.json")) installScript = `${pyBase}; ${both(m.install)}`;
    testCommand = files.has("package.json") ? m.test(Boolean(nodeTestScript)) : null;
    framework = testCommand ? (nodeTestScript ? `${m.name} test` : "bun test") : "none";
  } else if (kind === "go") {
    manager = "go modules";
    installScript = `${pyBase}; ${both("go mod download")}`;
    testCommand = "go test ./...";
    framework = "go test";
  } else if (kind === "rust") {
    manager = "cargo";
    installScript = `${pyBase}; ${both("cargo fetch")}`;
    testCommand = "cargo test";
    framework = "cargo test";
  } else if (kind === "make") {
    manager = "make";
    testCommand = makeTest ? "make test" : null;
    framework = testCommand ? "make test" : "none";
  }

  return { kind, manager, testCommand, framework, detected: [...detected], nodeTestScript, installScript };
}

/** No LLM here: lay out /workspace/{base,head}, detect the stack, install deps, report what tools exist. */
export async function prepareSandbox(
  sb: Sandbox,
  tarballs: { base: ArrayBuffer; head: ArrayBuffer },
  changedFiles: string[],
): Promise<{ tools: string; installLog: string; stack: StackInfo }> {
  await exec(sb, "mkdir -p /workspace/base /workspace/head /tmp/court", { timeoutSec: 20 });
  await Promise.all([
    upload(sb, "/tmp/court/base.tgz", tarballs.base),
    upload(sb, "/tmp/court/head.tgz", tarballs.head),
  ]);
  const extract = await exec(
    sb,
    "tar xzf /tmp/court/base.tgz -C /workspace/base --strip-components=1 && tar xzf /tmp/court/head.tgz -C /workspace/head --strip-components=1",
    { timeoutSec: 90 },
  );
  if (extract.exit_code !== 0) throw new Error(`extract failed: ${extract.stderr.slice(-500)}`);

  const { installScript, ...stack } = await detectStack(sb, changedFiles);
  const install = await exec(sb, `${ENV} ${installScript}`, { timeoutSec: 300 });

  const probe = await exec(
    sb,
    `python3 --version 2>&1; node --version 2>&1 | sed 's/^/node /'; bun --version 2>&1 | sed 's/^/bun /'; go version 2>&1 | head -1; cargo --version 2>&1 | head -1; for t in gcc make git; do command -v $t >/dev/null && echo "$t: yes" || echo "$t: no"; done; python3 -c "import hypothesis; print('hypothesis: yes')" 2>/dev/null || echo "hypothesis: no"`,
    { timeoutSec: 20 },
  );
  return { tools: probe.stdout.trim(), installLog: (install.stdout + install.stderr).trim(), stack };
}

function parseCounts(kind: StackKind, out: string): { passed: number; failed: number; errors: number; unit: string } {
  const last = (re: RegExp) => {
    const all = [...out.matchAll(re)];
    return all.length ? Number(all[all.length - 1]![1]) : 0;
  };
  const sum = (re: RegExp) => [...out.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0);
  if (kind === "python") return { passed: last(/(\d+) passed/g), failed: last(/(\d+) failed/g), errors: last(/(\d+) errors?/g), unit: "tests" };
  if (kind === "rust")
    return { passed: sum(/test result: \w+\. (\d+) passed/g), failed: sum(/test result: \w+\. \d+ passed; (\d+) failed/g), errors: 0, unit: "tests" };
  if (kind === "go")
    return { passed: (out.match(/^ok\s/gm) ?? []).length, failed: (out.match(/^(FAIL|---\s*FAIL)\s/gm) ?? []).length, errors: 0, unit: "packages" };
  if (kind === "node") {
    const summary = out.split("\n").reverse().find((l) => /^\s*Tests?:?\s/.test(l) && /\d+ (passed|failed)/.test(l)); // jest / vitest
    if (summary)
      return { passed: Number(summary.match(/(\d+) passed/)?.[1] ?? 0), failed: Number(summary.match(/(\d+) failed/)?.[1] ?? 0), errors: 0, unit: "tests" };
    if (/\d+ pass\b/.test(out)) return { passed: last(/(\d+) pass\b/g), failed: last(/(\d+) fail\b/g), errors: 0, unit: "tests" }; // bun test
    if (/(#|ℹ) pass \d+/.test(out)) return { passed: last(/(?:#|ℹ) pass (\d+)/g), failed: last(/(?:#|ℹ) fail (\d+)/g), errors: 0, unit: "tests" }; // node --test (tap / spec)
    if (/\d+ passing/.test(out)) return { passed: last(/(\d+) passing/g), failed: last(/(\d+) failing/g), errors: 0, unit: "tests" }; // mocha
  }
  return { passed: 0, failed: 0, errors: 0, unit: "tests" };
}

export async function runTestSuite(sb: Sandbox, checkout: Checkout, stack: StackInfo): Promise<TestSummary> {
  if (!stack.testCommand) {
    return { checkout, framework: "none", unit: "tests", passed: 0, failed: 0, errors: 0, exit_code: -1, tail: "No test command detected for this repo." };
  }
  const r = await exec(sb, `set -o pipefail; ${enter(checkout)} ${stack.testCommand} 2>&1 | tail -40`, { timeoutSec: 240 });
  const out = r.stdout + r.stderr;
  return { checkout, framework: stack.framework, ...parseCounts(stack.kind, out), exit_code: r.exit_code, tail: out.slice(-1500) };
}
