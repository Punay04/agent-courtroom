import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { config } from "./config";

let ai: GoogleGenAI | null = null;
const client = () => (ai ??= new GoogleGenAI({ apiKey: config.geminiKey }));

export interface FnCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface TurnResult {
  id: string;
  text: string;
  calls: FnCall[];
  status: string;
}

export interface TurnHooks {
  onText?: (delta: string) => void;
  /** Called with the accumulated (partial) JSON argument string of a function call while it streams. */
  onArgs?: (name: string, partialJson: string) => void;
}

export type FunctionTool = { type: "function"; name: string; description: string; parameters: Record<string, any> };

export interface TurnParams {
  model: string;
  system_instruction?: string;
  input: string | any[];
  tools?: FunctionTool[];
  previous_interaction_id?: string;
  generation_config?: Record<string, any>;
  response_format?: Record<string, any>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let delay = 2000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const status = e?.status ?? e?.statusCode ?? e?.code;
      const retryable = status === 429 || (typeof status === "number" && status >= 500);
      if (!retryable || attempt >= 4) throw e;
      console.warn(`[llm] ${label} got ${status}, retrying in ${delay}ms`);
      await sleep(delay);
      delay *= 2;
    }
  }
}

function collect(steps: any[] | undefined): { text: string; calls: FnCall[] } {
  let text = "";
  const calls: FnCall[] = [];
  for (const s of steps ?? []) {
    if (s.type === "model_output") {
      for (const c of s.content ?? []) if (c.type === "text") text += c.text;
    } else if (s.type === "function_call") {
      calls.push({ id: s.id, name: s.name, arguments: s.arguments ?? {} });
    }
  }
  return { text, calls };
}

/** One model turn. Streams text and function-call arguments through hooks when streaming is on. */
export async function turn(params: TurnParams, hooks: TurnHooks = {}): Promise<TurnResult> {
  if (!config.stream) {
    const res: any = await withRetry(() => client().interactions.create({ ...params, stream: false } as any), params.model);
    const { text, calls } = collect(res.steps);
    if (text) hooks.onText?.(text);
    return { id: res.id, text: text || res.output_text || "", calls, status: res.status };
  }

  const stream: any = await withRetry(() => client().interactions.create({ ...params, stream: true } as any), params.model);
  let id = "";
  let status = "";
  let finalSteps: any[] | undefined;
  const steps = new Map<number, { type: string; id?: string; name?: string; args: string; argsObj?: any; text: string }>();

  for await (const ev of stream) {
    switch (ev.event_type) {
      case "interaction.created":
        id = ev.interaction?.id ?? id;
        break;
      case "step.start": {
        const s = ev.step ?? {};
        const entry = { type: s.type, id: s.id, name: s.name, args: "", argsObj: s.arguments, text: "" };
        if (s.type === "model_output") {
          for (const c of s.content ?? []) if (c.type === "text" && c.text) {
            entry.text += c.text;
            hooks.onText?.(c.text);
          }
        }
        steps.set(ev.index, entry);
        break;
      }
      case "step.delta": {
        const entry = steps.get(ev.index) ?? { type: "unknown", args: "", text: "" };
        steps.set(ev.index, entry);
        const d = ev.delta ?? {};
        if (d.type === "text" && d.text) {
          if (entry.type === "unknown") entry.type = "model_output";
          entry.text += d.text;
          hooks.onText?.(d.text);
        } else if (d.type === "arguments_delta" && d.arguments) {
          entry.args += d.arguments;
          hooks.onArgs?.(entry.name ?? "", entry.args);
        }
        break;
      }
      case "interaction.completed":
        id = ev.interaction?.id ?? id;
        status = ev.interaction?.status ?? status;
        finalSteps = ev.interaction?.steps;
        break;
      case "interaction.status_update":
        status = ev.status ?? ev.interaction?.status ?? status;
        break;
      case "error":
        throw new Error(`Gemini stream error: ${JSON.stringify(ev.error ?? ev)}`);
    }
  }

  // Prefer the authoritative final steps when the completed event carries them.
  if (finalSteps?.length) {
    const { text, calls } = collect(finalSteps);
    return { id, text, calls, status };
  }
  let text = "";
  const calls: FnCall[] = [];
  for (const [, s] of [...steps.entries()].sort((a, b) => a[0] - b[0])) {
    if (s.type === "model_output") text += s.text;
    if (s.type === "function_call") {
      let args = s.argsObj && Object.keys(s.argsObj).length ? s.argsObj : {};
      if (s.args) {
        try {
          args = JSON.parse(s.args);
        } catch {
          /* keep argsObj */
        }
      }
      calls.push({ id: s.id ?? "", name: s.name ?? "", arguments: args });
    }
  }
  return { id, text, calls, status };
}

function jsonSchemaFor(schema: z.ZodType): Record<string, any> {
  const js: any = z.toJSONSchema(schema);
  delete js.$schema;
  return js;
}

/** Structured JSON output validated by zod; one retry on malformed output. */
export async function jsonTurn<T extends z.ZodType>(
  model: string,
  system: string,
  input: string,
  schema: T,
  generation_config: Record<string, any> = {},
): Promise<z.infer<T>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res: any = await withRetry(
      () =>
        client().interactions.create({
          model,
          system_instruction: system,
          input,
          response_format: { type: "text", mime_type: "application/json", schema: jsonSchemaFor(schema) },
          generation_config,
        } as any),
      model,
    );
    const raw = res.output_text ?? collect(res.steps).text;
    try {
      const cleaned = String(raw).trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
      return schema.parse(JSON.parse(cleaned));
    } catch (e) {
      lastErr = e;
      console.warn(`[llm] ${model} returned invalid JSON (attempt ${attempt + 1}):`, String(raw).slice(0, 200));
    }
  }
  throw lastErr;
}

/** Pull a (possibly unterminated) JSON string field out of a partial JSON document, for live typing. */
export function partialField(partialJson: string, field: string): string | null {
  const m = partialJson.match(new RegExp(`"${field}"\\s*:\\s*"`));
  if (!m || m.index === undefined) return null;
  let out = "";
  for (let i = m.index + m[0].length; i < partialJson.length; i++) {
    const ch = partialJson[i]!;
    if (ch === "\\") {
      const next = partialJson[i + 1];
      if (next === undefined) break;
      const map: Record<string, string> = { n: "\n", t: "\t", r: "", '"': '"', "\\": "\\", "/": "/" };
      if (next === "u") {
        const hex = partialJson.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 5;
      } else {
        out += map[next] ?? next;
        i++;
      }
    } else if (ch === '"') {
      break;
    } else {
      out += ch;
    }
  }
  return out;
}
