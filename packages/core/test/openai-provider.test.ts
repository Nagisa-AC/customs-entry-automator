import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OpenAIProvider, openAIConfigFromEnv, PAGE_PROMPT, ProviderError, type PageInput } from "../src/index.ts";

async function pageInput(): Promise<PageInput> {
  const dir = await mkdtemp(join(tmpdir(), "cea-openai-"));
  const imagePath = join(dir, "page-001.png");
  await writeFile(imagePath, Buffer.from("fake-png"));
  return { page: 1, pageCount: 2, imagePath, imageSha256: "x", text: "INVOICE 1", textSha256: "y" };
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

describe("OpenAIProvider", () => {
  it("sends one strict structured-output request with the page image and no tools", async () => {
    const { fn, calls } = mockFetch(200, {
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 1200, completion_tokens: 300 },
    });
    const p = new OpenAIProvider({ apiKey: "sk-test", model: "vision-model", baseUrl: "https://example.test/v1", fetch: fn });
    const res = await p.extractPage(await pageInput(), PAGE_PROMPT, signal());
    expect(res).toEqual({ rawText: '{"ok":true}', usage: { inputTokens: 1200, outputTokens: 300 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://example.test/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("vision-model");
    expect(body.temperature).toBe(0);
    expect(body.store).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages[0]).toEqual({ role: "system", content: PAGE_PROMPT });
    expect(body.messages[1].content[0].text).toContain("Page 1 of 2");
    expect(body.messages[1].content[1].image_url.url).toBe(`data:image/png;base64,${Buffer.from("fake-png").toString("base64")}`);
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
  ])("HTTP %i is transient=%s, and the error carries no response body", async (status, transient) => {
    const { fn } = mockFetch(status, { error: { message: "echoed invoice text" } });
    const p = new OpenAIProvider({ apiKey: "k", model: "m", fetch: fn });
    const err = await p.extractPage(await pageInput(), PAGE_PROMPT, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).transient).toBe(transient);
    expect((err as ProviderError).message).toBe(`HTTP ${status}`);
  });

  it("treats a refusal as a non-transient failure", async () => {
    const { fn } = mockFetch(200, { choices: [{ message: { content: null, refusal: "no" } }] });
    const p = new OpenAIProvider({ apiKey: "k", model: "m", fetch: fn });
    const err = await p.extractPage(await pageInput(), PAGE_PROMPT, signal()).catch((e: unknown) => e);
    expect((err as ProviderError).transient).toBe(false);
  });

  it("treats network errors as transient", async () => {
    const fn = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const p = new OpenAIProvider({ apiKey: "k", model: "m", fetch: fn });
    const err = await p.extractPage(await pageInput(), PAGE_PROMPT, signal()).catch((e: unknown) => e);
    expect((err as ProviderError).transient).toBe(true);
  });
});

describe("openAIConfigFromEnv", () => {
  const terms = { CEA_PROVIDER_ZERO_RETENTION: "confirmed", CEA_PROVIDER_REGION: "us" };

  it("refuses until zero-retention and US-region terms are attested", () => {
    const keys = { OPENAI_API_KEY: "k", CEA_OPENAI_MODEL: "m" };
    expect(() => openAIConfigFromEnv(keys)).toThrow(/CEA_PROVIDER_ZERO_RETENTION=confirmed and CEA_PROVIDER_REGION=us/);
    expect(() => openAIConfigFromEnv({ ...keys, CEA_PROVIDER_ZERO_RETENTION: "confirmed", CEA_PROVIDER_REGION: "eu" })).toThrow(/CEA_PROVIDER_REGION=us/);
    expect(() => openAIConfigFromEnv({ ...keys, CEA_PROVIDER_ZERO_RETENTION: "yes", CEA_PROVIDER_REGION: "us" })).toThrow(/ZERO_RETENTION/);
    const err = (() => {
      try {
        openAIConfigFromEnv(keys);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).transient).toBe(false);
  });

  it("requires a key and an explicit model", () => {
    expect(() => openAIConfigFromEnv(terms)).toThrow(/OPENAI_API_KEY/);
    expect(() => openAIConfigFromEnv({ ...terms, OPENAI_API_KEY: "k" })).toThrow(/CEA_OPENAI_MODEL/);
    expect(openAIConfigFromEnv({ ...terms, OPENAI_API_KEY: "k", CEA_OPENAI_MODEL: "m", OPENAI_BASE_URL: "https://us.example/v1" })).toEqual({
      apiKey: "k",
      model: "m",
      baseUrl: "https://us.example/v1",
    });
  });
});
