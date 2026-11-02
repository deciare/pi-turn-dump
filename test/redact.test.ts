/**
 * pi-turn-dump
 *
 * @license
 * Copyright 2026 deciare
 * SPDX-License-Identifier: MIT
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	createTurnDirectory,
	writeInput,
	writeMessages,
	writeMetadataFile,
	writeOutputFile,
} from "../src/dump.ts";
import { normalizeProviderRequest, normalizeTranscriptInput } from "../src/input.ts";
import { redactSecrets, redactSensitiveText } from "../src/redact.ts";

/** Creates a disposable test workspace. */
function workspace(): string {
	return mkdtempSync(join(tmpdir(), "pi-turn-dump-redact-"));
}

/** Treats a compact test fixture as Pi's runtime message union. */
function message(value: Record<string, unknown>): AgentMessage {
	return value as unknown as AgentMessage;
}

test("free-form text redacts common credential forms without hiding token limits", () => {
	const input = [
		"OPENAI_API_KEY=sk-proj-example-secret-value",
		"Authorization: Bearer abcdefghijklmnop",
		"curl -H 'Authorization: Basic short' https://example.test",
		"client_secret: a secret value containing spaces",
		'{"refresh_token":"refresh-value","max_tokens":100}',
		"https://user:password@example.test/path",
		"github_token=ghp_abcdefghijklmnopqrstuvwxyz",
		"https://bucket.example.test/file?X-Amz-Signature=abcdefghijklmnop",
		"AccountKey=abcdefghijklmnopqrstuvwxyz==",
		"jwt=eyJabcdefgh.abcdefgh.abcdefgh",
		"-----BEGIN PRIVATE KEY-----",
		"private material",
		"-----END PRIVATE KEY-----",
	].join("\n");

	const output = redactSensitiveText(input);
	assert.doesNotMatch(
		output,
		/sk-proj-example|abcdefghijklmnop|Basic short|secret value|refresh-value|user:password|ghp_abcdefgh|eyJabcdefgh|private material/,
	);
	assert.doesNotMatch(output, /X-Amz-Signature=[^[]/);
	assert.doesNotMatch(output, /AccountKey=[^[]/);
	assert.match(output, /\[REDACTED\]/);
	assert.match(output, /"max_tokens":100/);
	assert.equal(redactSensitiveText(output), output);
});

test("structured redaction covers nested keys and credential values", () => {
	const output = redactSecrets({
		headers: { authorization: "Bearer abcdefghijklmnop", accept: "application/json" },
		openaiApiKey: "opaque-value",
		nested: { clientSecret: "opaque-secret" },
		message: "AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz",
		max_tokens: 100,
	});

	assert.deepEqual(output, {
		headers: { authorization: "[REDACTED]", accept: "application/json" },
		openaiApiKey: "[REDACTED]",
		nested: { clientSecret: "[REDACTED]" },
		message: "AWS_SECRET_ACCESS_KEY=[REDACTED]",
		max_tokens: 100,
	});
});

test("all dump writers redact message, output, and metadata text", () => {
	const root = workspace();
	try {
		const turn = createTurnDirectory(root, "session-redact", new Date("2026-11-02T12:00:00.000Z"));
		const secret = "sk-proj-example-secret-value";
		writeMessages(
			turn.turnDir,
			[
				message({
					role: "toolResult",
					toolName: "bash",
					content: [{ type: "text", text: `API_KEY=${secret}` }],
					isError: false,
					timestamp: 1,
				}),
			],
			0,
		);
		writeInput(
			turn.turnDir,
			normalizeTranscriptInput([
				message({ role: "user", content: `TOKEN=${secret}`, timestamp: 1 }),
			]),
			1,
			"input-",
		);
		writeInput(
			turn.turnDir,
			normalizeProviderRequest({
				input: [{ role: "user", content: [{ type: "input_text", text: `API_KEY=${secret}` }] }],
				api_key: secret,
			}),
			0,
			"request-0001-",
		);
		writeOutputFile(turn.turnDir, `The token is ${secret}`, 1);
		writeMetadataFile(turn.turnDir, "run-meta.json", { assistant: `Bearer abcdefghijklmnop` });

		const combined = [
			readFileSync(join(turn.turnDir, "0000-toolresult.txt"), "utf8"),
			readFileSync(join(turn.turnDir, "input-0001-user.txt"), "utf8"),
			readFileSync(join(turn.turnDir, "request-0001-0000-user.txt"), "utf8"),
			readFileSync(join(turn.turnDir, "request-0001-params.json"), "utf8"),
			readFileSync(join(turn.turnDir, "0001-output.txt"), "utf8"),
			readFileSync(join(turn.turnDir, "run-meta.json"), "utf8"),
		].join("\n");
		assert.doesNotMatch(combined, /sk-proj-example|abcdefghijklmnop/);
		assert.match(combined, /\[REDACTED\]/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
