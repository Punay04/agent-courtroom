// bun src/smoke.ts: proves CreateOS (2 parallel sandboxes, streaming exec) and Gemini (streaming + JSON) work.
import { z } from "zod";
import { config, missingConfig } from "./config";
import { createSandbox, destroySandbox, exec } from "./courthouse";
import { Chat, functionResponse, jsonTurn } from "./llm";

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
  console.log(`[gemini] backend=${config.geminiBackend}, function-calling turn with ${config.counselModel}…`);
  const chat = new Chat({
    model: config.counselModel,
    system: "You are a test harness.",
    thinking: config.counselThinking,
    tools: [
      {
        name: "run_exhibit",
        description: "Run a script",
        parameters: {
          type: "object",
          properties: { argument: { type: "string" }, code: { type: "string" } },
          required: ["argument", "code"],
        },
      },
    ],
  });
  const r = await chat.send(
    [{ text: "Call the run_exhibit tool with a tiny python script that prints 2+2. Argument: 'arithmetic works'." }],
    { onText: (d) => process.stdout.write(d) },
  );
  console.log(`\n[gemini] calls=${JSON.stringify(r.calls)}`);
  const call = r.calls[0];
  if (call) {
    const r2 = await chat.send([functionResponse(call, { output: { stdout: "4\n", exit_code: 0 } })], {
      onText: (d) => process.stdout.write(d),
    });
    console.log(`\n[gemini] follow-up after function result: text=${JSON.stringify(r2.text.slice(0, 120))} calls=${r2.calls.length}`);
  }
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
