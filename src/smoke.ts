// bun src/smoke.ts: proves CreateOS (2 parallel sandboxes, streaming exec) and Gemini (streaming + JSON) work.
import { z } from "zod";
import { config, missingConfig } from "./config";
import { createSandbox, destroySandbox, exec } from "./courthouse";
import { jsonTurn, turn } from "./llm";

const missing = missingConfig();
if (missing.length) {
  console.error(`Missing env: ${missing.join(", ")}`);
  process.exit(1);
}

async function sandboxes() {
  console.log("[createos] creating 2 sandboxes in parallel…");
  const t0 = Date.now();
  const [a, b] = await Promise.all([createSandbox("court-smoke-a"), createSandbox("court-smoke-b")]);
  console.log(`[createos] ready in ${Date.now() - t0}ms: ${a.id}, ${b.id}`);
  try {
    const r = await exec(a, `python3 --version; for i in 1 2 3; do echo tick $i; sleep 0.3; done; python3 -m pip --version`, {
      timeoutSec: 30,
      onChunk: (s, d) => process.stdout.write(`  [${s}] ${d}`),
    });
    console.log(`[createos] exit=${r.exit_code} ${r.exec_ms}ms`);
    const t = await exec(b, "sleep 5", { timeoutSec: 2 });
    console.log(`[createos] timeout check: exit=${t.exit_code} timed_out=${t.timed_out}`);
  } finally {
    await Promise.all([destroySandbox(a), destroySandbox(b)]);
    console.log("[createos] destroyed both");
  }
}

async function gemini() {
  console.log(`[gemini] streaming turn with ${config.counselModel}…`);
  const r = await turn(
    {
      model: config.counselModel,
      input: "Call the run_exhibit tool with a tiny python script that prints 2+2. Argument: 'arithmetic works'.",
      tools: [
        {
          type: "function",
          name: "run_exhibit",
          description: "Run a script",
          parameters: {
            type: "object",
            properties: { argument: { type: "string" }, code: { type: "string" } },
            required: ["argument", "code"],
          },
        },
      ],
    },
    { onText: (d) => process.stdout.write(d), onArgs: (n, p) => process.stdout.write(`\r  [args ${n}] ${p.slice(-60)}`) },
  );
  console.log(`\n[gemini] id=${r.id} status=${r.status} calls=${JSON.stringify(r.calls)}`);
  const v = await jsonTurn(
    config.judgeModel,
    "You are a judge.",
    "Rule on: exhibit P-1 printed 4 for 2+2.",
    z.object({ ruling: z.enum(["BROKEN", "UPHELD", "INCONCLUSIVE"]), headline: z.string() }),
  );
  console.log(`[gemini] judge (${config.judgeModel}) JSON:`, v);
}

const which = process.argv[2];
if (!which || which === "sandbox") await sandboxes();
if (!which || which === "gemini") await gemini();
