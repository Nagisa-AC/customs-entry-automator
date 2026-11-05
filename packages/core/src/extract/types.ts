/** What the adapter hands a provider for one page. */
export interface PageInput {
  page: number;
  pageCount: number;
  imagePath: string;
  imageSha256: string;
  /** Text layer read from the PDF; may be empty or wrong, the image is authoritative. */
  text: string;
  textSha256: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** A provider's unparsed answer. The adapter, not the provider, validates it. */
export interface ProviderResponse {
  rawText: string;
  usage: Usage | null;
}

export interface ExtractionProvider {
  /** Stable provider id, e.g. "openai", "fixture". Part of the cache key. */
  readonly id: string;
  readonly model: string;
  extractPage(input: PageInput, prompt: string, signal: AbortSignal): Promise<ProviderResponse>;
}

/**
 * Thrown by providers. Only `transient` errors are retried. Messages must not
 * contain document content or provider response bodies.
 */
export class ProviderError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "ProviderError";
    this.transient = transient;
  }
}
