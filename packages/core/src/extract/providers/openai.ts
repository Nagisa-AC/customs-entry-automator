import { readFile } from "node:fs/promises";
import { PAGE_EXTRACTION_JSON_SCHEMA } from "../json-schema.ts";
import { pageUserMessage } from "../prompt.ts";
import { assertProviderDataTerms } from "./data-terms.ts";
import { ProviderError, type ExtractionProvider, type PageInput, type ProviderResponse } from "../types.ts";

export interface OpenAIConfig {
  apiKey: string;
  model: string;
  /** Override for a US-region or compatible endpoint. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Reads OPENAI_API_KEY, CEA_OPENAI_MODEL and optional OPENAI_BASE_URL.
 * Refuses unless zero-retention and US-region terms are attested.
 */
export function openAIConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAIConfig {
  assertProviderDataTerms("openai", env);
  const apiKey = env.OPENAI_API_KEY;
  const model = env.CEA_OPENAI_MODEL;
  if (!apiKey) throw new ProviderError("OPENAI_API_KEY is not set", false);
  if (!model) throw new ProviderError("CEA_OPENAI_MODEL is not set (choose a vision model explicitly)", false);
  return { apiKey, model, ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}) };
}

interface ChatResponse {
  choices?: { message?: { content?: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** OpenAI Chat Completions with strict JSON-schema structured output. No tools. */
export class OpenAIProvider implements ExtractionProvider {
  readonly id = "openai";
  readonly model: string;
  private readonly config: OpenAIConfig;

  constructor(config: OpenAIConfig) {
    this.config = config;
    this.model = config.model;
  }

  async extractPage(input: PageInput, prompt: string, signal: AbortSignal): Promise<ProviderResponse> {
    const image = (await readFile(input.imagePath)).toString("base64");
    const body = {
      model: this.model,
      temperature: 0,
      store: false,
      messages: [
        { role: "system", content: prompt },
        {
          role: "user",
          content: [
            { type: "text", text: pageUserMessage(input.page, input.pageCount, input.text) },
            { type: "image_url", image_url: { url: `data:image/png;base64,${image}`, detail: "high" } },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "page_extraction", strict: true, schema: PAGE_EXTRACTION_JSON_SCHEMA },
      },
    };
    const doFetch = this.config.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.config.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
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
    const data = (await res.json()) as ChatResponse;
    const message = data.choices?.[0]?.message;
    if (message?.refusal) throw new ProviderError("model refused the request", false);
    if (typeof message?.content !== "string") throw new ProviderError("response had no content", false);
    return {
      rawText: message.content,
      usage: data.usage ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 } : null,
    };
  }
}
