import { readFile } from "node:fs/promises";
import { PAGE_EXTRACTION_JSON_SCHEMA } from "../json-schema.ts";
import { pageUserMessage } from "../prompt.ts";
import { ProviderError, type ExtractionProvider, type PageInput, type ProviderResponse } from "../types.ts";

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Sent as `anthropic-beta` when set, for structured-output support. */
  beta?: string;
  maxTokens?: number;
  fetch?: typeof fetch;
}

/** Reads ANTHROPIC_API_KEY, CEA_ANTHROPIC_MODEL, optional ANTHROPIC_BASE_URL and CEA_ANTHROPIC_BETA. */
export function anthropicConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AnthropicConfig {
  const apiKey = env.ANTHROPIC_API_KEY;
  const model = env.CEA_ANTHROPIC_MODEL;
  if (!apiKey) throw new ProviderError("ANTHROPIC_API_KEY is not set", false);
  if (!model) throw new ProviderError("CEA_ANTHROPIC_MODEL is not set (choose a vision model explicitly)", false);
  return {
    apiKey,
    model,
    ...(env.ANTHROPIC_BASE_URL ? { baseUrl: env.ANTHROPIC_BASE_URL } : {}),
    ...(env.CEA_ANTHROPIC_BETA ? { beta: env.CEA_ANTHROPIC_BETA } : {}),
  };
}

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Anthropic Messages API with JSON-schema structured output. No tools. */
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
      output_format: { type: "json_schema", schema: PAGE_EXTRACTION_JSON_SCHEMA },
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.config.apiKey,
      "anthropic-version": "2023-06-01",
    };
    if (this.config.beta) headers["anthropic-beta"] = this.config.beta;
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
      throw new ProviderError(`HTTP ${res.status}`, res.status === 429 || res.status >= 500);
    }
    const data = (await res.json()) as MessagesResponse;
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
