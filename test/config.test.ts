/**
 * pi-turn-dump
 *
 * @license
 * Copyright 2026 deciare
 * SPDX-License-Identifier: MIT
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTurnDumpConfig } from "../src/config.ts";

/** Creates a disposable test workspace. */
function workspace(): string {
  return mkdtempSync(join(tmpdir(), "pi-turn-dump-config-"));
}

test("missing turn-dump.json leaves the extension inert", () => {
  const root = workspace();
  try {
    const loaded = loadTurnDumpConfig({
      agentDir: root,
      configDirName: ".pi",
      cwd: root,
      projectTrusted: false,
    });
    assert.equal(loaded.config.dumpDir, undefined);
    assert.equal(loaded.config.source, "input");
    assert.equal(loaded.config.maxBytes, 67_108_864);
    assert.equal(loaded.config.maxAgeMs, 21_600_000);
    assert.deepEqual(loaded.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted project configuration overrides global values", () => {
  const root = workspace();
  try {
    const projectDir = join(root, "project", ".pi");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(root, "turn-dump.json"),
      JSON.stringify({ dumpDir: "./dumps", source: "input", maxBytes: 1000 }),
    );
    writeFileSync(
      join(projectDir, "turn-dump.json"),
      JSON.stringify({ source: "request", maxAgeMs: 500 }),
    );

    const loaded = loadTurnDumpConfig({
      agentDir: root,
      configDirName: ".pi",
      cwd: join(root, "project"),
      projectTrusted: true,
    });
    assert.equal(loaded.config.dumpDir, join(root, "dumps"));
    assert.equal(loaded.config.source, "request");
    assert.equal(loaded.config.maxBytes, 1000);
    assert.equal(loaded.config.maxAgeMs, 500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown keys and invalid source values reject the file", () => {
  const root = workspace();
  try {
    writeFileSync(
      join(root, "turn-dump.json"),
      JSON.stringify({ dumpDir: "/tmp/example", source: "request", typo: true }),
    );
    let loaded = loadTurnDumpConfig({
      agentDir: root,
      configDirName: ".pi",
      cwd: root,
      projectTrusted: false,
    });
    assert.equal(loaded.config.dumpDir, undefined);
    assert.match(loaded.errors[0] ?? "", /unknown key: typo/);

    writeFileSync(
      join(root, "turn-dump.json"),
      JSON.stringify({ dumpDir: "/tmp/example", source: "everything" }),
    );
    loaded = loadTurnDumpConfig({
      agentDir: root,
      configDirName: ".pi",
      cwd: root,
      projectTrusted: false,
    });
    assert.equal(loaded.config.dumpDir, undefined);
    assert.match(loaded.errors[0] ?? "", /source must be/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
