import assert from "node:assert/strict";
import test from "node:test";

import { groqProvider } from "../lib/extract/groq.ts";
import { READER_SYSTEM_PROMPT } from "../lib/extract/prompt.ts";
import { ProviderError, type ReadRequest, type TextProvider } from "../lib/extract/provider-types.ts";
import { readWithRetry, resolveReader } from "../lib/extract/reader.ts";

/**
 * The Groq transport is tested against an injected fetch, which pins the
 * request shape — endpoint, bearer auth, JSON mode, data-URL image — without
 * a network. Which reader runs is decided by the ENVIRONMENT and never by the
 * request: a capture must not be able to choose where it is sent.
 */

const request: ReadRequest = {
  imageJpegBase64: "aGVsbG8=",
  system: READER_SYSTEM_PROMPT,
  prompt: "Reply with the JSON object only.",
  timeoutMs: 5_000,
};

function groqReply(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("with no key there is no provider, and a stated reason", () => {
  const resolved = resolveReader({});
  assert.equal(resolved.provider, null);
  assert.match(resolved.reason ?? "", /GROQ_API_KEY/);
});

test("a key selects Groq; the model and base URL come from the environment", () => {
  const resolved = resolveReader({ GROQ_API_KEY: "gsk_x", GROQ_MODEL: "some/other-model" });
  assert.equal(resolved.provider?.name, "groq");
  assert.equal(resolved.provider?.model, "some/other-model");
  assert.equal(resolveReader({ GROQ_API_KEY: "gsk_x" }).provider?.model, "qwen/qwen3.6-27b");
});

test("the Groq request carries the key, the model, JSON mode and the page image", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const provider = groqProvider({
    apiKey: "gsk_test",
    fetchImpl: async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return groqReply('{"readable": true, "fields": {}}');
    },
  });

  const reply = await provider.read(request);
  assert.equal(reply, '{"readable": true, "fields": {}}');
  assert.equal(seenUrl, "https://api.groq.com/openai/v1/chat/completions");

  const headers = seenInit?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer gsk_test");

  const body = JSON.parse(String(seenInit?.body)) as {
    model: string;
    temperature: number;
    max_tokens: number;
    response_format: { type: string };
    messages: [{ role: string; content: string }, { role: string; content: [{ image_url: { url: string } }, { text: string }] }];
  };
  assert.equal(body.model, "qwen/qwen3.6-27b");
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.response_format.type, "json_object");
  // Thinking is off: in JSON mode a reasoning model can spend the whole
  // budget on thoughts and hand back an empty reply.
  assert.equal((body as { reasoning_effort?: string }).reasoning_effort, "none");
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].content[0].image_url.url, "data:image/jpeg;base64,aGVsbG8=");
  assert.equal(body.messages[1].content[1].text, request.prompt);
});

test("a custom base URL is honoured, with or without a trailing slash", async () => {
  let seenUrl = "";
  const provider = groqProvider({
    apiKey: "gsk_x",
    baseUrl: "http://127.0.0.1:8787/v1/",
    fetchImpl: async (url) => {
      seenUrl = String(url);
      return groqReply("{}");
    },
  });
  await provider.read(request);
  assert.equal(seenUrl, "http://127.0.0.1:8787/v1/chat/completions");
});

test("a refused key reads as a named configuration fault, not retryable", async () => {
  const provider = groqProvider({ apiKey: "gsk_bad", fetchImpl: async () => new Response("{}", { status: 401 }) });
  await assert.rejects(provider.read(request), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /GROQ_API_KEY/);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("a rate limit is retryable and carries the server's requested delay", async () => {
  const provider = groqProvider({
    apiKey: "gsk_x",
    fetchImpl: async () => new Response("{}", { status: 429, headers: { "retry-after": "3" } }),
  });
  await assert.rejects(provider.read(request), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 3000);
    return true;
  });
});

test("a truncated reply is named as running out of room", async () => {
  const provider = groqProvider({
    apiKey: "gsk_x",
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"read' }, finish_reason: "length" }] }), { status: 200 }),
  });
  await assert.rejects(provider.read(request), /ran out of room/);
});

test("readWithRetry tries once more after a retryable fault, waiting as asked", async () => {
  const waits: number[] = [];
  let calls = 0;
  const flaky: TextProvider = {
    name: "groq",
    model: "m",
    async read() {
      calls += 1;
      if (calls === 1) throw new ProviderError("busy", { status: 429, retryable: true, retryAfterMs: 2500 });
      return "{}";
    },
  };
  const reply = await readWithRetry(flaky, request, { sleep: async (ms) => void waits.push(ms) });
  assert.equal(reply, "{}");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2500]);
});

test("readWithRetry never retries a fault that retrying cannot fix", async () => {
  let calls = 0;
  const refused: TextProvider = {
    name: "groq",
    model: "m",
    async read() {
      calls += 1;
      throw new ProviderError("refused", { status: 401, retryable: false });
    },
  };
  await assert.rejects(readWithRetry(refused, request, { sleep: async () => {} }), /refused/);
  assert.equal(calls, 1);
});

test("readWithRetry clamps the wait to the budget it was given", async () => {
  const waits: number[] = [];
  let calls = 0;
  const slow: TextProvider = {
    name: "groq",
    model: "m",
    async read() {
      calls += 1;
      if (calls === 1) throw new ProviderError("busy", { status: 429, retryable: true, retryAfterMs: 30_000 });
      return "{}";
    },
  };
  await readWithRetry(slow, request, { maxWaitMs: 4_000, sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(waits, [4_000]);
});

test("a refusal carries Groq's own reason, so a JSON-mode failure is diagnosable", async () => {
  const provider = groqProvider({
    apiKey: "gsk_x",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: { message: "Failed to generate JSON. Please adjust your prompt.", type: "invalid_request_error", code: "json_validate_failed", failed_generation: "{oops" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
  });
  await assert.rejects(provider.read(request), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /Failed to generate JSON/);
    assert.match(error.message, /json_validate_failed/);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("a refusal without a JSON body still carries the text", async () => {
  const provider = groqProvider({ apiKey: "gsk_x", fetchImpl: async () => new Response("Bad Request: image invalid", { status: 400 }) });
  await assert.rejects(provider.read(request), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /image invalid/);
    return true;
  });
});
