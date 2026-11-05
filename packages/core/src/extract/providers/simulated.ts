import type { PageExtraction } from "../../schema.ts";
import type { ExtractionProvider, PageInput, ProviderResponse } from "../types.ts";
import { FixtureProvider } from "./fixture.ts";

/**
 * Offline stand-in for a weaker model, for exercising the comparison
 * harness without API keys. Deterministically corrupts recorded extractions:
 * misreads the origin of the first row on each page (a silent error no rule
 * catches), adds a digit to the quantity of row 2 (caught by line math), and
 * drops the last row of the last page (an omission).
 */
export class SimulatedNoisyProvider implements ExtractionProvider {
  readonly id = "simulated-noisy";
  readonly model = "noisy-v1";
  private readonly inner: FixtureProvider;

  constructor(dir: string) {
    this.inner = new FixtureProvider(dir);
  }

  async extractPage(input: PageInput): Promise<ProviderResponse> {
    const { rawText } = await this.inner.extractPage(input);
    const page = JSON.parse(rawText) as PageExtraction;
    const first = page.lines[0];
    if (first?.countryOfOrigin) first.countryOfOrigin = first.countryOfOrigin === "CN" ? "VN" : "CN";
    const second = page.lines[1];
    if (second?.quantity) second.quantity = `${second.quantity}0`;
    if (input.page === input.pageCount && page.lines.length > 2) page.lines.pop();
    const usage = { inputTokens: 1500 + input.text.length, outputTokens: 40 * page.lines.length };
    return { rawText: JSON.stringify(page), usage };
  }
}
