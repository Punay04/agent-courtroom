import { createClient, type Sandbox } from "@nodeops-createos/sandbox";
import { config } from "./config";
import type { ExecResult } from "./types";

let client: ReturnType<typeof createClient> | null = null;
const box = () => (client ??= createClient());

const OUTPUT_CAP = 64_000;
const keepTail = (s: string, n = OUTPUT_CAP) => (s.length > n ? s.slice(-n) : s);
export const tail = (s: string, n: number) => (s.length > n ? `…[${s.length - n} chars cut]\n` + s.slice(-n) : s);
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function createSandbox(name: string): Promise<Sandbox> {
  console.log(`[courthouse] creating sandbox name=${name} shape=${config.shape} rootfs=${config.rootfs}`);
  const sb = await box().createSandbox({
    shape: config.shape,
    rootfs: config.rootfs,
    name,
    egress: config.egress.length ? config.egress : undefined,
  });
  console.log(`[courthouse] sandbox running id=${sb.id} name=${name} status=${sb.status}`);
  return sb;
}

export async function destroySandbox(sb: Sandbox | undefined): Promise<void> {
  if (!sb) return;
  console.log(`[courthouse] destroying sandbox id=${sb.id}`);
  await sb.destroy().catch((e) => console.warn(`[courthouse] destroy ${sb.id} failed:`, e?.message ?? e));
  console.log(`[courthouse] sandbox destroyed id=${sb.id}`);
}

/** Destroy sandboxes left behind by a crashed server so they don't eat the concurrency cap. */
export async function reapOrphans(): Promise<number> {
  let reaped = 0;
  for (const status of ["running", "creating"] as const) {
    const list = await box().listSandboxes({ status }).catch(() => []);
    for (const sb of list) {
      if (sb.name?.startsWith("court-")) {
        await destroySandbox(sb);
        reaped++;
      }
    }
  }
  return reaped;
}

/**
 * Run a bash script in the sandbox with a hard timeout, streaming output chunks.
 * Exit code 124/137 means the timeout fired.
 */
export async function exec(
  sb: Sandbox,
  script: string,
  opts: { timeoutSec: number; onChunk?: (stream: "stdout" | "stderr", data: string) => void },
): Promise<ExecResult> {
  const wrapped = `timeout -k 2 ${opts.timeoutSec} bash -c ${shq(script)}`;
  const started = performance.now();
  const preview = script.replace(/\s+/g, " ").slice(0, 220);
  console.log(`[exec ${sb.id}] start timeout=${opts.timeoutSec}s :: ${preview}`);
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  let chunks = 0;
  try {
    for await (const ev of sb.streamCommand("bash", ["-c", wrapped], { timeoutMs: (opts.timeoutSec + 20) * 1000 })) {
      chunks++;
      if (ev.type === "stdout") {
        stdout = keepTail(stdout + ev.data);
        opts.onChunk?.("stdout", ev.data);
        console.log(`[exec ${sb.id}] stdout ${ev.data.length}b ${oneLine(ev.data)}`);
      } else if (ev.type === "stderr") {
        stderr = keepTail(stderr + ev.data);
        opts.onChunk?.("stderr", ev.data);
        console.log(`[exec ${sb.id}] stderr ${ev.data.length}b ${oneLine(ev.data)}`);
      } else if (ev.type === "exit") {
        exitCode = ev.exitCode;
        console.log(`[exec ${sb.id}] stream exit_code=${ev.exitCode}`);
      } else if (ev.type === "error") {
        stderr += `\n[sandbox error] ${ev.message}`;
        console.log(`[exec ${sb.id}] stream error: ${ev.message}`);
      } else {
        console.log(`[exec ${sb.id}] stream ${ev.type}`);
      }
    }
  } catch (e: any) {
    stderr += `\n[sandbox error] ${e?.message ?? e}`;
    console.log(`[exec ${sb.id}] threw: ${e?.message ?? e}`);
  }
  const exec_ms = Math.round(performance.now() - started);
  console.log(
    `[exec ${sb.id}] done exit=${exitCode} ${exec_ms}ms chunks=${chunks} stdout=${stdout.length}b stderr=${stderr.length}b`,
  );
  return { exit_code: exitCode, exec_ms, timed_out: exitCode === 124 || exitCode === 137, stdout, stderr };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").slice(0, 180);

export async function upload(sb: Sandbox, path: string, data: string | ArrayBuffer): Promise<void> {
  const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  console.log(`[upload ${sb.id}] ${path} ${bytes} bytes`);
  await sb.files.upload(path, data);
  console.log(`[upload ${sb.id}] ${path} stored`);
}
