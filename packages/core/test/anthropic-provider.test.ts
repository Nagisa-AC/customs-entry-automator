import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnthropicProvider, anthropicConfigFromEnv, extract, PAGE_EXTRACTION_JSON_SCHEMA, PAGE_PROMPT, ProviderError, type PageInput } from "../src/index.ts";

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
      usage: { input_tokens: 1800, output_tokens: 420, inference_geo: "us" },
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
    expect(body.inference_geo).toBe("us");
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
    expect((err as ProviderError).message).toBe(status === 400 ? "HTTP 400 (models before Claude 4.6 reject inference_geo)" : `HTTP ${status}`);
  });

  it.each(["refusal", "max_tokens"])("treats stop_reason %s as a non-transient failure", async (stop_reason) => {
    const { fn } = mockFetch(200, { content: [{ type: "text", text: "{" }], stop_reason, usage: { inference_geo: "us" } });
    const err = await new AnthropicProvider({ apiKey: "k", model: "m", fetch: fn }).extractPage(await pageInput(), PAGE_PROMPT, signal()).catch((e: unknown) => e);
    expect((err as ProviderError).transient).toBe(false);
  });

  it.each([
    ["global", { inference_geo: "global" }, 'reported "global"'],
    ["missing", { input_tokens: 1, output_tokens: 1 }, "reported nothing"],
    ["no usage", undefined, "reported nothing"],
    ["non-string", { inference_geo: { region: "eu" } }, "reported an unrecognised value"],
    ["text-like", { inference_geo: "Invoice INV-1001 total $1,525.00" }, "reported an unrecognised value"],
  ])("fails closed and non-transient when usage.inference_geo is %s", async (_label, usage, reported) => {
    const { fn, calls } = mockFetch(200, { content: [{ type: "text", text: '{"secret":"invoice text"}' }], stop_reason: "end_turn", ...(usage ? { usage } : {}) });
    const err = await new AnthropicProvider({ apiKey: "k", model: "m", fetch: fn }).extractPage(await pageInput(), PAGE_PROMPT, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).transient).toBe(false);
    expect((err as ProviderError).message).toContain(reported);
    expect((err as ProviderError).message).not.toMatch(/secret|invoice text|INV-1001/);
    expect(calls).toHaveLength(1);
  });

  it("writes the failure reason, and no document content, into the page record", async () => {
    const { fn, calls } = mockFetch(200, { content: [{ type: "text", text: '{"secret":"invoice text"}' }], stop_reason: "end_turn", usage: { inference_geo: "global" } });
    const outDir = await mkdtemp(join(tmpdir(), "cea-anthropic-out-"));
    const [outcome] = await extract([await pageInput()], { provider: new AnthropicProvider({ apiKey: "k", model: "m", fetch: fn }), outDir, retryDelayMs: 0 });
    expect(calls).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "failed", extraction: null });
    expect(outcome!.error).toMatch(/inference location not proven.*"global"/);
    const files = await readdir(outDir);
    expect(files).toEqual(["page-002.json"]);
    const record = await readFile(join(outDir, "page-002.json"), "utf8");
    expect(JSON.parse(record)).toEqual({ page: 2, status: "failed", error: outcome!.error });
    expect(record).not.toMatch(/secret|invoice text/);
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
