import assert from "node:assert/strict";
import test from "node:test";

import { groqProvider } from "../lib/reader/groq.ts";
import { ProviderError, type ReadRequest } from "../lib/reader/provider-types.ts";
import { resolveReader } from "../lib/reader/provider.ts";
import { fieldInstruction, READER_SYSTEM_PROMPT } from "../lib/reader/prompt.ts";

/**
 * Provider selection and the Groq transport.
 *
 * Selection is tested as a matrix because it is server policy: which reader
 * runs is decided by the ENVIRONMENT and never by anything in the request —
 * a capture must not be able to choose where it is sent.
 *
 * The Groq client is tested against an injected fetch, which pins the request
 * shape (endpoint, bearer auth, JSON mode, data-URL image) without a network.
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

test("with no key configured there is no provider, and a stated reason", () => {
  const resolved = resolveReader({});
  assert.equal(resolved.provider, null);
  assert.ok(resolved.reason);
});

test("a single key selects its provider", () => {
  assert.equal(resolveReader({ GROQ_API_KEY: "gsk_x" }).provider?.name, "groq");
  assert.equal(resolveReader({ ANTHROPIC_API_KEY: "sk-ant-x" }).provider?.name, "anthropic");
});

test("with both keys, the more accurate reader wins unless a preference is stated", () => {
  const both = { GROQ_API_KEY: "gsk_x", ANTHROPIC_API_KEY: "sk-ant-x" };
  assert.equal(resolveReader(both).provider?.name, "anthropic");
  assert.equal(resolveReader({ ...both, FORMLINK_TEXT_PROVIDER: "groq" }).provider?.name, "groq");
});

test("forcing a provider whose key is missing is a configuration fault, not a fallback", () => {
  const resolved = resolveReader({ GROQ_API_KEY: "gsk_x", FORMLINK_TEXT_PROVIDER: "anthropic" });
  // Falling back to Groq here would silently send patient forms to a provider
  // the operator explicitly chose against.
  assert.equal(resolved.provider, null);
  assert.match(resolved.reason ?? "", /ANTHROPIC_API_KEY/);
  // And it is MISCONFIGURED, not unconfigured: the screen must not tell this
  // operator to add a key they already added.
  assert.equal(resolved.misconfigured, true);
});

test("a typo'd provider name is misconfigured; a plain missing key is not", () => {
  const typo = resolveReader({ GROQ_API_KEY: "gsk_x", FORMLINK_TEXT_PROVIDER: "qroq" });
  assert.equal(typo.provider, null);
  assert.equal(typo.misconfigured, true);
  assert.match(typo.reason ?? "", /unknown provider/);

  const bare = resolveReader({});
  assert.equal(bare.misconfigured, undefined);
});

test("FORMLINK_TEXT_MODEL overrides the default model", () => {
  const resolved = resolveReader({ GROQ_API_KEY: "gsk_x", FORMLINK_TEXT_MODEL: "some/other-model" });
  assert.equal(resolved.provider?.model, "some/other-model");
});

test("the Groq request carries the key, the model, JSON mode and the crop", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const provider = groqProvider({
    apiKey: "gsk_test",
    fetchImpl: async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return groqReply('{"value": "Fever"}');
    },
  });

  const reply = await provider.read(request);
  assert.equal(reply, '{"value": "Fever"}');
  assert.equal(seenUrl, "https://api.groq.com/openai/v1/chat/completions");

  const headers = seenInit?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer gsk_test");

  const body = JSON.parse(String(seenInit?.body)) as {
    model: string;
    temperature: number;
    response_format: { type: string };
    messages: [{ role: string; content: string }, { role: string; content: [{ image_url: { url: string } }, { text: string }] }];
  };
  assert.equal(body.model, "qwen/qwen3.6-27b");
  assert.equal(body.temperature, 0);
  assert.equal(body.response_format.type, "json_object");
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].content[0].image_url.url, "data:image/jpeg;base64,aGVsbG8=");
  assert.equal(body.messages[1].content[1].text, request.prompt);
});

test("a refused key reads as a named configuration fault, not retryable", async () => {
  const provider = groqProvider({
    apiKey: "gsk_bad",
    fetchImpl: async () => new Response("{}", { status: 401 }),
  });
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

test("a reply missing its content is a provider fault, in words", async () => {
  const provider = groqProvider({
    apiKey: "gsk_x",
    fetchImpl: async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
  });
  await assert.rejects(provider.read(request), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("the field instruction names the label and choices, and demands JSON", () => {
  const instruction = fieldInstruction({
    id: "b",
    key: "bloodGroup",
    label: "Blood Group",
    type: "dropdown",
    options: ["A+", "B+"],
  });
  assert.match(instruction, /"Blood Group"/);
  assert.match(instruction, /A\+, B\+/);
  // Groq's JSON mode refuses a request whose prompt never says "JSON" — the
  // word must appear in the combined instruction, and the system prompt
  // carries it too.
  assert.match(instruction, /JSON/);
  assert.match(READER_SYSTEM_PROMPT, /JSON/);
  // The key must NOT appear: the model never sees or returns a key, so it
  // cannot address a different field than the one this request is bound to.
  assert.doesNotMatch(instruction, /bloodGroup/);
});
