import assert from "node:assert/strict";
import test from "node:test";

import { isReasoningModel, openaiEffort, openaiProvider } from "../lib/extract/openai.ts";
import { ProviderError, type ReadRequest } from "../lib/extract/provider-types.ts";

/**
 * The OpenAI transport is tested against an injected fetch, which pins the
 * differences from Groq's endpoint that would otherwise fail live: the
 * completion budget's name, no temperature on a thinking model, the
 * reasoning setting, high-detail images, and the words for "no credit".
 */

const request: ReadRequest = { imagesJpegBase64: ["AAAA", "BBBB"], system: "rules", prompt: "the fields", timeoutMs: 5_000 };

function capture(status = 200, body: unknown = { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }) {
  const seen: { url?: string; init?: RequestInit } = {};
  const fetchImpl: typeof fetch = async (url, init) => {
    seen.url = String(url);
    seen.init = init;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { seen, fetchImpl };
}

test("a GPT-5 request takes max_completion_tokens, reasoning_effort, high-detail images and no temperature", async () => {
  const { seen, fetchImpl } = capture();
  const provider = openaiProvider({ apiKey: "sk-test", fetchImpl });
  assert.equal(provider.name, "openai");
  await provider.read(request);
  assert.equal(seen.url, "https://api.openai.com/v1/chat/completions");
  const headers = seen.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer sk-test");
  const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown> & {
    messages: [{ role: string; content: string }, { role: string; content: { type: string; image_url?: { url: string; detail: string }; text?: string }[] }];
  };
  assert.equal(body.model, "gpt-5.4-mini");
  assert.equal(body.max_completion_tokens, 8000);
  assert.equal(body.reasoning_effort, "low");
  assert.equal("temperature" in body, false);
  assert.equal("max_tokens" in body, false);
  assert.deepEqual(body.response_format, { type: "json_object" });
  const parts = body.messages[1].content;
  assert.deepEqual(parts.map((part) => part.type), ["image_url", "image_url", "text"]);
  assert.equal(parts[0]?.image_url?.detail, "high");
  assert.ok(parts[0]?.image_url?.url.endsWith("AAAA"));
  assert.equal(parts[2]?.text, "the fields");
});

test("the reply budget from the request is honoured, and 'default' reasoning leaves the model to itself", async () => {
  const { seen, fetchImpl } = capture();
  await openaiProvider({ apiKey: "sk-test", reasoning: "default", fetchImpl }).read({ ...request, maxTokens: 1234 });
  const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown>;
  assert.equal(body.max_completion_tokens, 1234);
  assert.equal("reasoning_effort" in body, false);
});

test("a non-reasoning model gets temperature 0 and max_tokens instead", async () => {
  const { seen, fetchImpl } = capture();
  await openaiProvider({ apiKey: "sk-test", model: "gpt-4.1", fetchImpl }).read(request);
  const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown>;
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 8000);
  assert.equal("reasoning_effort" in body, false);
  assert.equal(isReasoningModel("gpt-4.1"), false);
  assert.equal(isReasoningModel("gpt-5.5"), true);
  assert.equal(isReasoningModel("o4-mini"), true);
});

test("an account without credit is named as such, and is not worth a retry", async () => {
  const { fetchImpl } = capture(429, { error: { message: "You have no credits remaining.", type: "insufficient_quota", code: "credit_balance_exhausted" } });
  await assert.rejects(openaiProvider({ apiKey: "sk-test", fetchImpl }).read(request), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /no credit/);
    assert.match(error.message, /billing/);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("a rate limit is retryable and a refused key is named", async () => {
  const busy = capture(429, { error: { message: "Rate limit reached", code: "rate_limit_exceeded" } });
  await assert.rejects(openaiProvider({ apiKey: "sk-test", fetchImpl: busy.fetchImpl }).read(request), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.retryable, true);
    assert.match(error.message, /busy/);
    return true;
  });
  const refused = capture(401, { error: { message: "Incorrect API key" } });
  await assert.rejects(openaiProvider({ apiKey: "sk-bad", fetchImpl: refused.fetchImpl }).read(request), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /OPENAI_API_KEY/);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("a reply cut short by the budget is reported as such", async () => {
  const { fetchImpl } = capture(200, { choices: [{ message: { content: "{\"readable\": true" }, finish_reason: "length" }] });
  await assert.rejects(openaiProvider({ apiKey: "sk-test", fetchImpl }).read(request), /ran out of room/);
});

test("each model family gets the effort word it accepts", () => {
  // GPT-5.1 and later: "none" and "xhigh" exist, "minimal" does not.
  assert.equal(openaiEffort("gpt-5.4-mini", "minimal"), "none");
  assert.equal(openaiEffort("gpt-5.4-mini", "none"), "none");
  assert.equal(openaiEffort("gpt-5.5", "xhigh"), "xhigh");
  // The first GPT-5: "minimal" exists, "none" and "xhigh" do not.
  assert.equal(openaiEffort("gpt-5", "none"), "minimal");
  assert.equal(openaiEffort("gpt-5-mini", "xhigh"), "high");
  assert.equal(openaiEffort("gpt-5-nano", "low"), "low");
  // The o-series: low, medium, high only.
  assert.equal(openaiEffort("o4-mini", "none"), "low");
  assert.equal(openaiEffort("o3", "minimal"), "low");
  assert.equal(openaiEffort("o3", "xhigh"), "high");
});

test("a chat variant of GPT-5 is not a reasoning model and gets no reasoning_effort", async () => {
  assert.equal(isReasoningModel("gpt-5-chat-latest"), false);
  assert.equal(isReasoningModel("gpt-5.2-chat-latest"), false);
  const { seen, fetchImpl } = capture();
  await openaiProvider({ apiKey: "sk-test", model: "gpt-5.2-chat-latest", fetchImpl }).read(request);
  const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown>;
  assert.equal("reasoning_effort" in body, false);
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 8000);
});

test("an empty account is recognised by the error type alone", async () => {
  const { fetchImpl } = capture(429, { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: null } });
  await assert.rejects(openaiProvider({ apiKey: "sk-test", fetchImpl }).read(request), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.retryable, false);
    assert.match(error.message, /no credit/);
    return true;
  });
});
