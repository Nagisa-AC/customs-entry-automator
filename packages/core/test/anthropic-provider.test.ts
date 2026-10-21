import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnthropicProvider, anthropicConfigFromEnv, PAGE_EXTRACTION_JSON_SCHEMA, PAGE_PROMPT, ProviderError, type PageInput } from "../src/index.ts";

async function pageInput(): Promise<PageInput> {
  const dir = await mkdtemp(join(tmpdir(), "cea-anthropic-"));
  const imagePath = join(dir, "page-001.png");
  await writeFile(imagePath, Buffer.from("fake-png"));
  return { page: 2, pageCount: 3, imagePath, imageSha256: "x", text: "INVOICE", textSha256: "y" };
}

function mockFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const signal = () => AbortSignal.timeout(5_000);

describe("AnthropicProvider", () => {
  it("sends one structured-output Messages request with the page image and no tools", async () => {
    const { fn, calls } = mockFetch(200, {
      content: [{ type: "text", text: '{"ok":' }, { type: "text", text: "true}" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1800, output_tokens: 420 },
    });
    const p = new AnthropicProvider({ apiKey: "sk-ant", model: "vision-model", fetch: fn });
    const res = await p.extractPage(await pageInput(), PAGE_PROMPT, signal());
    expect(res).toEqual({ rawText: '{"ok":true}', usage: { inputTokens: 1800, outputTokens: 420 } });
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBeUndefined();
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({ model: "vision-model", temperature: 0, system: PAGE_PROMPT });
    expect(body.tools).toBeUndefined();
    expect(body.output_format).toBeUndefined();
    expect(body.output_config).toEqual({ format: { type: "json_schema", schema: PAGE_EXTRACTION_JSON_SCHEMA } });
    expect(body.messages[0].content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("fake-png").toString("base64") } });
    expect(body.messages[0].content[1].text).toContain("Page 2 of 3");
  });

  it.each([
    [429, true],
    [529, true],
    [500, true],
    [400, false],
    [403, false],
  ])("HTTP %i is transient=%s, without echoing the body", async (status, transient) => {
    const { fn } = mockFetch(status, { error: { message: "secret invoice text" } });
    const err = await new AnthropicProvider({ apiKey: "k", model: "m", fetch: fn }).extractPage(await pageInput(), PAGE_PROMPT, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).transient).toBe(transient);
    expect((err as ProviderError).message).toBe(`HTTP ${status}`);
  });

  it.each(["refusal", "max_tokens"])("treats stop_reason %s as a non-transient failure", async (stop_reason) => {
    const { fn } = mockFetch(200, { content: [{ type: "text", text: "{" }], stop_reason });
    const err = await new AnthropicProvider({ apiKey: "k", model: "m", fetch: fn }).extractPage(await pageInput(), PAGE_PROMPT, signal()).catch((e: unknown) => e);
    expect((err as ProviderError).transient).toBe(false);
  });

});

describe("anthropicConfigFromEnv", () => {
  const terms = { CEA_PROVIDER_ZERO_RETENTION: "confirmed", CEA_PROVIDER_REGION: "us" };

  it("refuses until zero-retention and US-region terms are attested", () => {
    expect(() => anthropicConfigFromEnv({ ANTHROPIC_API_KEY: "k", CEA_ANTHROPIC_MODEL: "m" })).toThrow(/anthropic is disabled/);
  });

  it("requires a key and an explicit model", () => {
    expect(() => anthropicConfigFromEnv(terms)).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => anthropicConfigFromEnv({ ...terms, ANTHROPIC_API_KEY: "k" })).toThrow(/CEA_ANTHROPIC_MODEL/);
    expect(anthropicConfigFromEnv({ ...terms, ANTHROPIC_API_KEY: "k", CEA_ANTHROPIC_MODEL: "m", ANTHROPIC_BASE_URL: "https://x" })).toEqual({ apiKey: "k", model: "m", baseUrl: "https://x" });
  });
});
