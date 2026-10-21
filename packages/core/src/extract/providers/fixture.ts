import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderError, type ExtractionProvider, type PageInput, type ProviderResponse } from "../types.ts";

/**
 * Offline provider: replays recorded per-page extractions
 * (`<dir>/page-NNN.json`). Used for tests, demos and running without API keys.
 */
export class FixtureProvider implements ExtractionProvider {
  readonly id = "fixture";
  readonly model = "recorded-v1";
  constructor(private readonly dir: string) {}

  async extractPage(input: PageInput): Promise<ProviderResponse> {
    const path = join(this.dir, `page-${String(input.page).padStart(3, "0")}.json`);
    try {
      return { rawText: await readFile(path, "utf8"), usage: null };
    } catch {
      throw new ProviderError(`no recorded extraction for page ${input.page}`, false);
    }
  }
}
