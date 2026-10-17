import type { Sandbox } from "@nodeops-createos/sandbox";
import { exec, upload } from "./courthouse";
import type { Checkout, TestSummary } from "./types";

// PEP 668 images refuse system-wide pip installs without this.
const PIP = "PIP_BREAK_SYSTEM_PACKAGES=1 PIP_DISABLE_PIP_VERSION_CHECK=1 python3 -m pip install -q";

/** No LLM here: lay out /workspace/{base,head}, install deps, report what tools exist. */
export async function prepareSandbox(
  sb: Sandbox,
  tarballs: { base: ArrayBuffer; head: ArrayBuffer },
): Promise<{ tools: string; installLog: string }> {
  await exec(sb, "mkdir -p /workspace/base /workspace/head /workspace/exhibits /tmp/court", { timeoutSec: 20 });
  await Promise.all([
    upload(sb, "/tmp/court/base.tgz", tarballs.base),
    upload(sb, "/tmp/court/head.tgz", tarballs.head),
  ]);
  const extract = await exec(
    sb,
    "tar xzf /tmp/court/base.tgz -C /workspace/base --strip-components=1 && tar xzf /tmp/court/head.tgz -C /workspace/head --strip-components=1",
    { timeoutSec: 60 },
  );
  if (extract.exit_code !== 0) throw new Error(`extract failed: ${extract.stderr.slice(-500)}`);

  const install = await exec(
    sb,
    [
      "cd /workspace/head",
      "python3 -m pip --version >/dev/null 2>&1 || python3 -m ensurepip >/dev/null 2>&1 || true",
      `${PIP} pytest hypothesis 2>&1 | tail -3`,
      `if [ -f requirements.txt ]; then ${PIP} -r requirements.txt 2>&1 | tail -3; fi`,
      `if [ -f requirements-dev.txt ]; then ${PIP} -r requirements-dev.txt 2>&1 | tail -3; fi`,
    ].join("; "),
    { timeoutSec: 150 },
  );

  const probe = await exec(
    sb,
    `python3 --version 2>&1; for t in pip3 pytest node bun gcc git curl; do command -v $t >/dev/null && echo "$t: yes" || echo "$t: no"; done; python3 -c "import hypothesis; print('hypothesis: yes')" 2>/dev/null || echo "hypothesis: no"`,
    { timeoutSec: 20 },
  );
  return { tools: probe.stdout.trim(), installLog: (install.stdout + install.stderr).trim() };
}

export async function runTestSuite(sb: Sandbox, checkout: Checkout): Promise<TestSummary> {
  const r = await exec(
    sb,
    `set -o pipefail; cd /workspace/${checkout} && PYTHONPATH=/workspace/${checkout} python3 -m pytest -q -p no:cacheprovider 2>&1 | tail -25`,
    { timeoutSec: 120 },
  );
  const out = r.stdout + r.stderr;
  const num = (re: RegExp) => Number(out.match(re)?.[1] ?? 0);
  return {
    checkout,
    passed: num(/(\d+) passed/),
    failed: num(/(\d+) failed/),
    errors: num(/(\d+) errors?/),
    exit_code: r.exit_code,
    tail: out.slice(-1500),
  };
}
