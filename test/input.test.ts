/**
 * pi-turn-dump
 *
 * @license
 * Copyright 2026 deciare
 * SPDX-License-Identifier: MIT
 */

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProviderRequest } from "../src/input.ts";

test("provider normalization supports system plus messages layouts", () => {
  const input = normalizeProviderRequest({
    model: "claude-test",
    system: [{ type: "text", text: "system instructions" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "question" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ],
    max_tokens: 100,
    temperature: 0,
  });

  assert.equal(input.kind, "request");
  assert.deepEqual(
    input.messages.map((message) => message.role),
    ["system", "user", "assistant"],
  );
  assert.deepEqual(
    input.messages.map((message) => message.text),
    ["system instructions", "question", "answer"],
  );
  assert.deepEqual(input.params, { model: "claude-test", max_tokens: 100, temperature: 0 });
});

test("provider normalization maps contents and model roles", () => {
  const input = normalizeProviderRequest({
    contents: [{ role: "model", parts: [{ text: "generated text" }] }],
    generationConfig: { temperature: 0.2 },
  });

  assert.deepEqual(input.messages, [{ role: "assistant", text: "generated text" }]);
  assert.deepEqual(input.params, { generationConfig: { temperature: 0.2 } });
});

test("unknown provider payloads fall back to one request message", () => {
  const input = normalizeProviderRequest({ custom_body: { value: 1 } });
  assert.equal(input.messages.length, 1);
  assert.equal(input.messages[0]?.role, "request");
  assert.match(input.messages[0]?.text ?? "", /custom_body/);
  assert.equal(input.params, undefined);
});
