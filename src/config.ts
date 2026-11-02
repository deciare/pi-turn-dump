/**
 * pi-turn-dump
 *
 * @license
 * Copyright 2026 deciare
 * SPDX-License-Identifier: MIT
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/** How much of Pi's request pipeline a dump captures. */
export type TurnDumpSource = "input" | "request";

/** Effective turn-dump configuration. */
export interface TurnDumpConfig {
	/** Root directory for all dumps. When absent, the extension is inert. */
	dumpDir?: string;
	/** Total byte cap, including indexes. Defaults to 64 MiB. */
	maxBytes: number;
	/** Maximum age for turn directories and index rows. Defaults to six hours. */
	maxAgeMs: number;
	/** Input transcript mode or provider-native request mode. */
	source: TurnDumpSource;
}

/** Files consulted while loading configuration. */
export interface TurnDumpConfigLoad {
	config: TurnDumpConfig;
	errors: string[];
	paths: string[];
}

/** Options needed to locate global and trusted project configuration. */
export interface LoadTurnDumpConfigOptions {
	agentDir: string;
	configDirName: string;
	cwd: string;
	projectTrusted: boolean;
}

type ConfigFileValues = Partial<TurnDumpConfig>;

const DEFAULT_MAX_BYTES = 67_108_864;
const DEFAULT_MAX_AGE_MS = 21_600_000;
const CONFIG_KEYS = new Set(["dumpDir", "maxBytes", "maxAgeMs", "source"]);

/** Whether a JSON value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Removes a UTF-8 byte-order mark before parsing a JSON file. */
function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Expands a leading tilde without involving the shell or environment. */
export function expandHomePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return path;
}

/** Resolves a dump directory relative to the file that declared it. */
function resolveDumpDir(path: string, configPath: string): string {
	const expanded = expandHomePath(path);
	return resolve(dirname(configPath), expanded);
}

/** Parses and validates one configuration file into partial effective values. */
function parseConfigFile(configPath: string): { values?: ConfigFileValues; error?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(readFileSync(configPath, "utf8")));
	} catch (error) {
		return {
			error: `${configPath}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	if (!isRecord(parsed)) {
		return { error: `${configPath}: expected a JSON object` };
	}

	const unknownKeys = Object.keys(parsed).filter((key) => !CONFIG_KEYS.has(key));
	if (unknownKeys.length > 0) {
		return {
			error: `${configPath}: unknown ${unknownKeys.length === 1 ? "key" : "keys"}: ${unknownKeys.join(", ")}`,
		};
	}

	const values: ConfigFileValues = {};

	if (parsed.dumpDir !== undefined) {
		if (typeof parsed.dumpDir !== "string" || parsed.dumpDir.length === 0) {
			return { error: `${configPath}: dumpDir must be a non-empty string` };
		}
		values.dumpDir = resolveDumpDir(parsed.dumpDir, configPath);
	}

	if (parsed.maxBytes !== undefined) {
		if (!Number.isSafeInteger(parsed.maxBytes) || (parsed.maxBytes as number) < 0) {
			return { error: `${configPath}: maxBytes must be a non-negative safe integer` };
		}
		values.maxBytes = parsed.maxBytes as number;
	}

	if (parsed.maxAgeMs !== undefined) {
		if (!Number.isSafeInteger(parsed.maxAgeMs) || (parsed.maxAgeMs as number) < 0) {
			return { error: `${configPath}: maxAgeMs must be a non-negative safe integer` };
		}
		values.maxAgeMs = parsed.maxAgeMs as number;
	}

	if (parsed.source !== undefined) {
		if (parsed.source !== "input" && parsed.source !== "request") {
			return { error: `${configPath}: source must be "input" or "request"` };
		}
		values.source = parsed.source;
	}

	return { values };
}

/** Merges a valid file into the accumulated values. Invalid files are ignored in full. */
function mergeConfigFile(
	values: ConfigFileValues,
	configPath: string,
	errors: string[],
): ConfigFileValues {
	if (!existsSync(configPath)) return values;

	const parsed = parseConfigFile(configPath);
	if (parsed.error !== undefined) {
		errors.push(parsed.error);
		return values;
	}
	return { ...values, ...parsed.values };
}

/**
 * Loads mergeable values from `turn-dump.json` in Pi's agent directory and,
 * when trust is active, from the project's Pi configuration directory.
 */
export function loadTurnDumpConfig(options: LoadTurnDumpConfigOptions): TurnDumpConfigLoad {
	const globalPath = resolve(options.agentDir, "turn-dump.json");
	const projectPath = resolve(options.cwd, options.configDirName, "turn-dump.json");
	const paths = [globalPath];
	if (options.projectTrusted) paths.push(projectPath);

	const errors: string[] = [];
	let values: ConfigFileValues = {};
	values = mergeConfigFile(values, globalPath, errors);
	if (options.projectTrusted) {
		values = mergeConfigFile(values, projectPath, errors);
	}

	return {
		config: {
			...(values.dumpDir === undefined ? {} : { dumpDir: values.dumpDir }),
			maxBytes: values.maxBytes ?? DEFAULT_MAX_BYTES,
			maxAgeMs: values.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
			source: values.source ?? "input",
		},
		errors,
		paths,
	};
}
