import { readFile } from "node:fs/promises";
import { PAGE_EXTRACTION_JSON_SCHEMA } from "../json-schema.ts";
import { pageUserMessage } from "../prompt.ts";
import { assertProviderDataTerms } from "./data-terms.ts";
import { ProviderError, type ExtractionProvider, type PageInput, type ProviderResponse } from "../types.ts";

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  fetch?: typeof fetch;
}

/**
 * Reads ANTHROPIC_API_KEY, CEA_ANTHROPIC_MODEL and optional ANTHROPIC_BASE_URL.
 * Refuses unless zero-retention and US-region terms are attested.
 */
export function anthropicConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AnthropicConfig {
  assertProviderDataTerms("anthropic", env);
  const apiKey = env.ANTHROPIC_API_KEY;
  const model = env.CEA_ANTHROPIC_MODEL;
  if (!apiKey) throw new ProviderError("ANTHROPIC_API_KEY is not set", false);
  if (!model) throw new ProviderError("CEA_ANTHROPIC_MODEL is not set (choose a vision model explicitly)", false);
  return { apiKey, model, ...(env.ANTHROPIC_BASE_URL ? { baseUrl: env.ANTHROPIC_BASE_URL } : {}) };
}

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; inference_geo?: unknown };
}

/** Sent on every request; the data-terms guard only admits CEA_PROVIDER_REGION=us. */
export const ANTHROPIC_INFERENCE_GEO = "us";

/**
 * Fails closed unless the response reports US inference. This verifies, it
 * doesn't prevent: a rejected page was already processed wherever it ran.
 */
function assertUsInference(geo: unknown): void {
  if (geo === ANTHROPIC_INFERENCE_GEO) return;
  const reported = typeof geo === "string" && /^[a-z0-9_-]{1,32}$/i.test(geo) ? `"${geo}"` : geo === undefined ? "nothing" : "an unrecognised value";
  throw new ProviderError(`inference location not proven: requested inference_geo "${ANTHROPIC_INFERENCE_GEO}", response reported ${reported}; result discarded`, false);
}

/** Anthropic Messages API with JSON-schema structured output and US-only inference. No tools. */
export class AnthropicProvider implements ExtractionProvider {
  readonly id = "anthropic";
  readonly model: string;
  private readonly config: AnthropicConfig;

  constructor(config: AnthropicConfig) {
    this.config = config;
    this.model = config.model;
  }

  async extractPage(input: PageInput, prompt: string, signal: AbortSignal): Promise<ProviderResponse> {
    const image = (await readFile(input.imagePath)).toString("base64");
    const body = {
      model: this.model,
      max_tokens: this.config.maxTokens ?? 16_000,
      temperature: 0,
      system: prompt,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
            { type: "text", text: pageUserMessage(input.page, input.pageCount, input.text) },
          ],
        },
      ],
      output_config: { format: { type: "json_schema", schema: PAGE_EXTRACTION_JSON_SCHEMA } },
      inference_geo: ANTHROPIC_INFERENCE_GEO,
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.config.apiKey,
      "anthropic-version": "2023-06-01",
    };
    const doFetch = this.config.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.config.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) throw err;
      throw new ProviderError("network error", true);
    }
    if (!res.ok) {
      const hint = res.status === 400 ? " (models before Claude 4.6 reject inference_geo)" : "";
      throw new ProviderError(`HTTP ${res.status}${hint}`, res.status === 429 || res.status >= 500);
    }
    const data = (await res.json()) as MessagesResponse;
    assertUsInference(data.usage?.inference_geo);
    if (data.stop_reason === "refusal") throw new ProviderError("model refused the request", false);
    if (data.stop_reason === "max_tokens") throw new ProviderError("response truncated at max_tokens", false);
    const text = data.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    if (!text) throw new ProviderError("response had no text content", false);
    return {
      rawText: text,
      usage: data.usage ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 } : null,
    };
  }
}
