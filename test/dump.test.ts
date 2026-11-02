/**
 * pi-turn-dump
 *
 * @license
 * Copyright 2026 deciare
 * SPDX-License-Identifier: MIT
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TurnDumpConfig } from "../src/config.ts";
import {
  appendIndexRows,
  countImages,
  createTurnDirectory,
  pruneDump,
  redactSecrets,
  renderMessage,
  sanitizeSessionKey,
  writeMessages,
  writeOutputFile,
  writeRequestFile,
  type IndexRow,
} from "../src/dump.ts";

/** Creates a disposable test workspace. */
function workspace(): string {
  return mkdtempSync(join(tmpdir(), "pi-turn-dump-test-"));
}

/** Treats a compact test fixture as Pi's runtime message union. */
function message(value: Record<string, unknown>): AgentMessage {
  return value as unknown as AgentMessage;
}

/** Builds the default effective configuration for direct writer tests. */
function config(dumpDir: string, maxBytes = 1_000_000, maxAgeMs = 1_000_000): TurnDumpConfig {
  return { dumpDir, maxBytes, maxAgeMs, source: "input" };
}

test("session keys are safe and timestamp directories collide safely", () => {
  const root = workspace();
  try {
    assert.equal(sanitizeSessionKey("../../agent:main\\dashboard\0"), "_.._agent:main_dashboard_");
    const date = new Date("2026-11-01T12:34:56.789Z");
    const first = createTurnDirectory(root, "agent:main/dashboard", date);
    const second = createTurnDirectory(root, "agent:main/dashboard", date);
    assert.equal(first.relativeDir, "agent:main_dashboard/2026-11-01T12:34:56.789Z");
    assert.equal(second.turnName, "2026-11-01T12:34:56.789Z-2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("message files retain role-specific content and image counts", () => {
  const root = workspace();
  try {
    const turn = createTurnDirectory(root, "session-1", new Date("2026-11-01T12:00:00.000Z"));
    const messages = [
      message({
        role: "system",
        content: "base prompt",
        sections: { tools: "<tools>read</tools>" },
        toolsAdded: [{ name: "read" }],
        timestamp: 1,
      }),
      message({ role: "user", content: [{ type: "text", text: "inspect this" }, { type: "image", data: "abcd", mimeType: "image/png" }], timestamp: 2 }),
      message({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should read it." },
          { type: "text", text: "Reading now." },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/a" } },
        ],
        timestamp: 3,
      }),
      message({ role: "toolResult", toolName: "read", content: [{ type: "text", text: "file text" }], isError: false, timestamp: 4 }),
      message({ role: "compactionSummary", summary: "prior summary", tokensBefore: 10, timestamp: 5 }),
      message({ role: "branchSummary", summary: "branch summary", fromId: null, timestamp: 6 }),
      message({ role: "bashExecution", command: "pwd", output: "/tmp", exitCode: 0, cancelled: false, truncated: false, timestamp: 7 }),
      message({ role: "custom", customType: "injected", content: "runtime context", display: false, timestamp: 8 }),
    ];

    const written = writeMessages(turn.turnDir, messages, 0);
    assert.equal(written.messages, messages.length);
    assert.equal(written.nextSequence, messages.length);
    assert.equal(countImages(messages), 1);
    assert.match(readFileSync(join(turn.turnDir, "0000-system.txt"), "utf8"), /base prompt/);
    assert.match(readFileSync(join(turn.turnDir, "0000-system.txt"), "utf8"), /tools added: read/);
    assert.match(readFileSync(join(turn.turnDir, "0001-user.txt"), "utf8"), /image: image\/png/);
    assert.match(readFileSync(join(turn.turnDir, "0002-assistant.txt"), "utf8"), /tool call: read/);
    assert.match(readFileSync(join(turn.turnDir, "0004-compactionsummary.txt"), "utf8"), /prior summary/);
    assert.match(readFileSync(join(turn.turnDir, "0005-branchsummary.txt"), "utf8"), /branch summary/);
    assert.match(readFileSync(join(turn.turnDir, "0006-bashexecution.txt"), "utf8"), /\$ pwd/);
    assert.match(readFileSync(join(turn.turnDir, "0007-custom.txt"), "utf8"), /runtime context/);
    assert.match(renderMessage(messages[2] as AgentMessage), /I should read it/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider requests redact credential-shaped keys and outputs use the next sequence", () => {
  const root = workspace();
  try {
    const turn = createTurnDirectory(root, "session-2", new Date("2026-11-01T12:00:00.000Z"));
    const request = writeRequestFile(turn.turnDir, 1, {
      apiKey: "sk-secret",
      headers: { Authorization: "Bearer secret", "X-Trace": "trace-1" },
      max_tokens: 100,
    });
    const requestText = readFileSync(join(turn.turnDir, request.filename), "utf8");
    assert.match(requestText, /\[REDACTED\]/);
    assert.doesNotMatch(requestText, /sk-secret|Bearer secret/);
    assert.match(requestText, /max_tokens/);

    const output = writeOutputFile(turn.turnDir, "final answer", 3);
    assert.equal(output.nextSequence, 4);
    assert.equal(readFileSync(join(turn.turnDir, "0003-output.txt"), "utf8"), "final answer");

    const redacted = redactSecrets({ refresh_token: "secret", nested: { clientSecret: "secret" }, keep: "value" });
    assert.deepEqual(redacted, {
      refresh_token: "[REDACTED]",
      nested: { clientSecret: "[REDACTED]" },
      keep: "value",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("age pruning removes turn directories and their index rows", () => {
  const root = workspace();
  try {
    const oldDate = new Date("2026-11-01T10:00:00.000Z");
    const newDate = new Date("2026-11-01T12:00:00.000Z");
    const oldTurn = createTurnDirectory(root, "session-3", oldDate);
    const newTurn = createTurnDirectory(root, "session-3", newDate);
    writeFileSync(join(oldTurn.turnDir, "0000-user.txt"), "old");
    writeFileSync(join(newTurn.turnDir, "0000-user.txt"), "new");
    utimesSync(join(oldTurn.turnDir, "0000-user.txt"), oldDate, oldDate);
    utimesSync(oldTurn.turnDir, oldDate, oldDate);

    const row = (dir: string, timestamp: string): IndexRow => ({
      kind: "input",
      timestamp,
      runId: timestamp,
      sessionId: "session-3",
      messages: 1,
      chars: 3,
      dir,
    });
    appendIndexRows(oldTurn.sessionDir, [row(oldTurn.relativeDir, oldDate.toISOString()), row(newTurn.relativeDir, newDate.toISOString())]);

    pruneDump(config(root, 1_000_000, 60 * 60 * 1000), newDate.getTime());
    assert.equal(existsSync(oldTurn.turnDir), false);
    assert.equal(existsSync(newTurn.turnDir), true);
    const index = readFileSync(join(oldTurn.sessionDir, "index.tsv"), "utf8");
    assert.doesNotMatch(index, /10:00:00/);
    assert.match(index, /12:00:00/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("byte pruning removes the oldest complete turn directory first", () => {
  const root = workspace();
  try {
    const first = createTurnDirectory(root, "session-4", new Date("2026-11-01T12:00:00.000Z"));
    const second = createTurnDirectory(root, "session-4", new Date("2026-11-01T12:00:01.000Z"));
    writeFileSync(join(first.turnDir, "0000-user.txt"), "a".repeat(200));
    writeFileSync(join(second.turnDir, "0000-user.txt"), "b".repeat(200));

    pruneDump(config(root, 250, 1_000_000), new Date("2026-11-01T12:00:02.000Z").getTime());
    assert.equal(existsSync(first.turnDir), false);
    assert.equal(existsSync(second.turnDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("intermediate pruning preserves the active turn, then finalization can remove it whole", () => {
  const root = workspace();
  try {
    const turn = createTurnDirectory(root, "session-5", new Date("2026-11-01T12:00:00.000Z"));
    writeFileSync(join(turn.turnDir, "0000-user.txt"), "partial");
    const now = new Date("2026-11-01T12:00:01.000Z").getTime();
    pruneDump(config(root, 1, 1_000_000), now, turn.turnDir);
    assert.equal(existsSync(turn.turnDir), true);
    pruneDump(config(root, 1, 1_000_000), now);
    assert.equal(existsSync(turn.turnDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compatible indexes append instead of duplicating their header", () => {
  const root = workspace();
  try {
    const turn = createTurnDirectory(root, "session-6", new Date("2026-11-01T12:00:00.000Z"));
    const row: IndexRow = {
      kind: "output",
      timestamp: "2026-11-01T12:00:00.000Z",
      runId: "run-1",
      sessionId: "session-6",
      messages: 0,
      chars: 5,
      dir: turn.relativeDir,
    };
    appendIndexRows(turn.sessionDir, [row]);
    appendIndexRows(turn.sessionDir, [{ ...row, runId: "run-2" }]);
    const lines = readFileSync(join(turn.sessionDir, "index.tsv"), "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.equal(lines.filter((line) => line.startsWith("kind\t")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
