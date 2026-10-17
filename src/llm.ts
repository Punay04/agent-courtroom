import { FunctionCallingConfigMode, GoogleGenAI, ThinkingLevel, type Content, type Part } from "@google/genai";
import { z } from "zod";
import { config } from "./config";

let ai: GoogleGenAI | null = null;
const client = () =>
  (ai ??= config.geminiBackend === "vertex"
    ? new GoogleGenAI({ vertexai: true, apiKey: config.geminiKey })
    : new GoogleGenAI({ apiKey: config.geminiKey }));

export interface FnCall {
  id?: string;
  name: string;
  arguments: Record<string, any>;
}

export interface FunctionTool {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface ChatHooks {
  onText?: (delta: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let delay = 2000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const status = e?.status ?? e?.code;
      const retryable = status === 429 || (typeof status === "number" && status >= 500);
      if (!retryable || attempt >= 4) throw e;
      console.warn(`[llm] ${label} got ${status}, retrying in ${delay}ms`);
      await sleep(delay);
      delay *= 2;
    }
  }
}

const thinking = (level?: string) => {
  const map: Record<string, ThinkingLevel> = {
    minimal: ThinkingLevel.MINIMAL,
    low: ThinkingLevel.LOW,
    medium: ThinkingLevel.MEDIUM,
    high: ThinkingLevel.HIGH,
  };
  return level && map[level] ? { thinkingConfig: { thinkingLevel: map[level] } } : {};
};

/**
 * Multi-turn function-calling conversation over generateContent (works on both the Gemini API and Vertex AI).
 * The full model Content, including thought signatures, is appended back unchanged, as Gemini 3 requires.
 */
export class Chat {
  private history: Content[] = [];

  constructor(
    private opts: { model: string; system: string; tools?: FunctionTool[]; thinking?: string },
  ) {}

  async send(parts: Part[], hooks: ChatHooks = {}, opts: { toolsOff?: boolean } = {}): Promise<{ text: string; calls: FnCall[] }> {
    const contents: Content[] = [...this.history, { role: "user", parts }];
    const request = {
      model: this.opts.model,
      contents,
      config: {
        systemInstruction: this.opts.system,
        ...(this.opts.tools?.length
          ? {
              tools: [
                {
                  functionDeclarations: this.opts.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parametersJsonSchema: t.parameters,
                  })),
                },
              ],
              toolConfig: {
                functionCallingConfig: { mode: opts.toolsOff ? FunctionCallingConfigMode.NONE : FunctionCallingConfigMode.AUTO },
              },
            }
          : {}),
        ...thinking(this.opts.thinking),
      },
    };

    const modelParts: Part[] = [];
    let text = "";
    let finishReason: string | undefined;
    const take = (p: Part) => {
      modelParts.push(p);
      if (p.text && !p.thought) {
        text += p.text;
        hooks.onText?.(p.text);
      }
    };

    if (config.stream) {
      const stream = await withRetry(() => client().models.generateContentStream(request), this.opts.model);
      for await (const chunk of stream) {
        const cand = chunk.candidates?.[0];
        finishReason = cand?.finishReason ?? finishReason;
        for (const p of cand?.content?.parts ?? []) take(p);
      }
    } else {
      const res = await withRetry(() => client().models.generateContent(request), this.opts.model);
      const cand = res.candidates?.[0];
      finishReason = cand?.finishReason;
      for (const p of cand?.content?.parts ?? []) take(p);
    }

    if (!modelParts.length) throw new Error(`empty model response (finishReason=${finishReason ?? "unknown"})`);
    // Commit the turn only once it succeeded, so a retry never leaves a dangling user message.
    this.history = [...contents, { role: "model", parts: modelParts }];
    const calls: FnCall[] = modelParts
      .filter((p) => p.functionCall)
      .map((p) => ({ id: p.functionCall!.id, name: p.functionCall!.name ?? "", arguments: (p.functionCall!.args as any) ?? {} }));
    return { text, calls };
  }
}

export function functionResponse(call: FnCall, response: Record<string, unknown>): Part {
  return { functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response } };
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
  thinkingLevel?: string,
): Promise<z.infer<T>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const contents =
      attempt === 0
        ? input
        : `${input}\n\nYour previous reply was not valid JSON for the required schema (${String(lastErr).slice(0, 500)}). Reply with only the JSON object.`;
    const res = await withRetry(
      () =>
        client().models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: system,
            responseMimeType: "application/json",
            responseJsonSchema: jsonSchemaFor(schema),
            ...thinking(thinkingLevel),
          },
        }),
      model,
    );
    const raw = res.text ?? "";
    try {
      const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
      return schema.parse(JSON.parse(cleaned));
    } catch (e) {
      lastErr = e;
      console.warn(`[llm] ${model} returned invalid JSON (attempt ${attempt + 1}):`, raw.slice(0, 200));
    }
  }
  throw lastErr;
}
