import { createClient, type Sandbox } from "@nodeops-createos/sandbox";
import { config } from "./config";
import type { ExecResult } from "./types";

let client: ReturnType<typeof createClient> | null = null;
const box = () => (client ??= createClient());

const OUTPUT_CAP = 64_000;
const keepTail = (s: string, n = OUTPUT_CAP) => (s.length > n ? s.slice(-n) : s);
export const tail = (s: string, n: number) => (s.length > n ? `…[${s.length - n} chars cut]\n` + s.slice(-n) : s);
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Every sandbox name starts with this server's tag, so reapOrphans only touches its own. The old bare "court-" prefix
 * let any server sharing the CreateOS key (a laptop, say) destroy production's live trials when it booted. The word
 * changed too, so servers still running that old reaper leave these alone.
 */
const PREFIX = `trial-${Bun.hash(config.sandboxTag).toString(36).padStart(4, "0").slice(-4)}-`;

/** CreateOS names max out at 22 chars and the prefix takes 11, so `label` gets the other 11. */
export async function createSandbox(label: string): Promise<Sandbox> {
  return box().createSandbox({
    shape: config.shape,
    rootfs: config.rootfs,
    name: PREFIX + label.slice(-11),
    egress: config.egress.length ? config.egress : undefined,
  });
}

export async function destroySandbox(sb: Sandbox | undefined): Promise<void> {
  if (!sb) return;
  await sb.destroy().catch((e) => console.warn(`[courthouse] destroy ${sb.id} failed:`, e?.message ?? e));
}

/** Destroy sandboxes this server left behind when it crashed or was replaced, so they don't eat the concurrency cap. */
export async function reapOrphans(): Promise<number> {
  let reaped = 0;
  for (const status of ["running", "creating"] as const) {
    const list = await box().listSandboxes({ status }).catch(() => []);
    for (const sb of list) {
      if (sb.name?.startsWith(PREFIX)) {
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
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  try {
    for await (const ev of sb.streamCommand("bash", ["-c", wrapped], { timeoutMs: (opts.timeoutSec + 20) * 1000 })) {
      if (ev.type === "stdout") {
        stdout = keepTail(stdout + ev.data);
        opts.onChunk?.("stdout", ev.data);
      } else if (ev.type === "stderr") {
        stderr = keepTail(stderr + ev.data);
        opts.onChunk?.("stderr", ev.data);
      } else if (ev.type === "exit") {
        exitCode = ev.exitCode;
      } else if (ev.type === "error") {
        stderr += `\n[sandbox error] ${ev.message}`;
      }
    }
  } catch (e: any) {
    stderr += `\n[sandbox error] ${e?.message ?? e}`;
  }
  const exec_ms = Math.round(performance.now() - started);
  return { exit_code: exitCode, exec_ms, timed_out: exitCode === 124 || exitCode === 137, stdout, stderr };
}

export async function upload(sb: Sandbox, path: string, data: string | ArrayBuffer): Promise<void> {
  await sb.files.upload(path, data);
}
