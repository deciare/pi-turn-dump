/**
 * pi-turn-dump
 *
 * @license
 * Copyright 2026 deciare
 * SPDX-License-Identifier: MIT
 */

import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	rmdirSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TurnDumpConfig } from "./config.ts";
import type { NormalizedDumpInput } from "./input.ts";
import { isSensitiveKey, REDACTED, redactSensitiveText, redactSecrets, safeJsonStringify } from "./redact.ts";

export { redactSecrets, safeJsonStringify } from "./redact.ts";

/** One row in a session's tab-separated event index. */
export interface IndexRow {
	kind: "input" | "request" | "turn" | "output";
	timestamp: string;
	runId: string;
	sessionId: string;
	provider?: string;
	model?: string;
	messages?: number;
	images?: number;
	chars: number;
	ok?: boolean;
	ms?: number;
	dir: string;
}

/** Paths for one turn directory. */
export interface TurnDirectory {
	sessionKey: string;
	sessionDir: string;
	turnName: string;
	turnDir: string;
	relativeDir: string;
}

/** Result of writing a sequence of message files. */
export interface MessageWriteResult {
	messages: number;
	chars: number;
	nextSequence: number;
}

/** Result of writing one normalized input event. */
export interface InputWriteResult extends MessageWriteResult {
	paramsChars: number;
	paramsFilename?: string;
}

const INDEX_COLUMNS = [
	"kind",
	"timestamp",
	"runId",
	"sessionId",
	"provider",
	"model",
	"messages",
	"images",
	"chars",
	"ok",
	"ms",
	"dir",
] as const;

const TURN_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?:-\d+)?$/;
/** Returns a plain object view of an unknown value. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Renders an image without writing its potentially large base64 payload to disk. */
function renderImage(block: Record<string, unknown>): string {
	const mimeType = typeof block.mimeType === "string" ? block.mimeType : "unknown";
	const dataLength = typeof block.data === "string" ? block.data.length : 0;
	return `[image: ${mimeType}, ${dataLength} base64 chars]`;
}

/** Renders one content block, retaining tool calls and thinking that plain text extraction would lose. */
function renderContentBlock(block: unknown): string {
	const record = asRecord(block);
	if (record === undefined) return String(block ?? "");
	if (record.type === undefined && typeof record.text === "string") return record.text;

	switch (record.type) {
		case "text":
		case "input_text":
		case "output_text":
			return typeof record.text === "string" ? record.text : "";
		case "image":
		case "input_image":
		case "output_image":
			return renderImage(record);
		case "thinking": {
			const thinking =
				typeof record.thinking === "string"
					? record.thinking
					: typeof record.text === "string"
						? record.text
						: "";
			return `[thinking]\n${thinking}`;
		}
		case "reasoning": {
			const reasoning =
				typeof record.summary === "string"
					? record.summary
					: typeof record.text === "string"
						? record.text
						: "";
			return `[reasoning]\n${reasoning}`;
		}
		case "toolCall": {
			const name = typeof record.name === "string" ? record.name : "unknown";
			const id = typeof record.id === "string" ? record.id : "unknown";
			const args = record.arguments === undefined ? {} : record.arguments;
			return `[tool call: ${name} (${id})]\n${safeJsonStringify(args)}`;
		}
		case "tool_use":
		case "tool_call":
		case "function_call": {
			const name = typeof record.name === "string" ? record.name : "unknown";
			const id = typeof record.id === "string" ? record.id : String(record.call_id ?? "unknown");
			const args = record.arguments ?? record.input ?? {};
			return `[tool call: ${name} (${id})]\n${safeJsonStringify(args)}`;
		}
		case "tool_result":
		case "function_call_output":
			return `[tool result]\n${renderContent(record.output ?? record.content)}`;
		default:
			return safeJsonStringify(record);
	}
}

/** Renders message content as readable text while retaining structured blocks. */
export function renderContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map(renderContentBlock).filter((part) => part.length > 0).join("\n\n");
	}
	if (content === undefined || content === null) return "";
	return renderContentBlock(content);
}

/** Returns names from a system message tool list. */
function toolNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		const record = asRecord(entry);
		return record !== undefined && typeof record.name === "string" ? [record.name] : [];
	});
}

/** Renders a complete system prompt plus any tool-loadout changes. */
function renderSystemMessage(message: Record<string, unknown>): string {
	const parts = [renderContent(message.content)];
	const sections = asRecord(message.sections);
	if (sections !== undefined) {
		for (const [name, value] of Object.entries(sections)) {
			if (typeof value !== "string") continue;
			parts.push(`[system section: ${name}]\n${value}`);
		}
	}

	const added = toolNames(message.toolsAdded);
	if (added.length > 0) parts.push(`[tools added: ${added.join(", ")}]`);
	const removed = toolNames(message.toolsRemoved);
	if (removed.length > 0) parts.push(`[tools removed: ${removed.join(", ")}]`);

	return parts.filter((part) => part.length > 0).join("\n\n");
}

/** Renders any Pi agent message as the cleartext stored in a message file. */
export function renderMessage(message: AgentMessage): string {
	const record = asRecord(message);
	if (record === undefined) return safeJsonStringify(message);

	const role = typeof record.role === "string" ? record.role : "unknown";
	switch (role) {
		case "system":
			return renderSystemMessage(record);
		case "custom": {
			const customType = typeof record.customType === "string" ? record.customType : "unknown";
			const display = typeof record.display === "boolean" ? `, display=${String(record.display)}` : "";
			const parts = [`[custom message: ${customType}${display}]`, renderContent(record.content)];
			if (record.details !== undefined) parts.push(`[details]\n${safeJsonStringify(record.details)}`);
			return parts.filter((part) => part.length > 0).join("\n");
		}
		case "bashExecution": {
			const command = typeof record.command === "string" ? record.command : "";
			const output = typeof record.output === "string" ? record.output : "";
			const status = [
				record.cancelled === true ? "cancelled=true" : undefined,
				typeof record.exitCode === "number" ? `exitCode=${record.exitCode}` : undefined,
				record.truncated === true ? "truncated=true" : undefined,
			].filter((value): value is string => value !== undefined);
			return [`$ ${command}`, output, ...(status.length > 0 ? [`[${status.join(", ")}]`] : [])]
				.filter((part) => part.length > 0)
				.join("\n");
		}
		case "compactionSummary":
		case "branchSummary":
			return typeof record.summary === "string" ? record.summary : "";
		case "toolResult": {
			const toolName = typeof record.toolName === "string" ? record.toolName : "unknown";
			const status = record.isError === true ? "error" : "ok";
			return [`[tool result: ${toolName}, ${status}]`, renderContent(record.content)]
				.filter((part) => part.length > 0)
				.join("\n");
		}
		case "assistant":
		case "user":
			return renderContent(record.content);
		default:
			return safeJsonStringify(message);
	}
}

/** Returns the safe filename role for a message. */
export function messageRole(message: unknown): string {
	const record = asRecord(message);
	const raw = record !== undefined && typeof record.role === "string" ? record.role : "unknown";
	return raw.toLowerCase().replace(/[^a-z0-9_-]/g, "_") || "unknown";
}

/** Counts image blocks in message content. */
export function countImages(messages: readonly unknown[]): number {
	let count = 0;
	for (const message of messages) {
		const content = asRecord(message)?.content;
		if (!Array.isArray(content)) continue;
		count += content.filter((block) => asRecord(block)?.type === "image").length;
	}
	return count;
}

/** Finds the last assistant message and returns its text blocks. */
export function lastAssistantText(messages: readonly AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = asRecord(messages[index]);
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		return message.content
			.flatMap((block) => {
				const record = asRecord(block);
				return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
			})
			.join("\n");
	}
	return "";
}

/** Determines whether a low-level run ended with a successful final assistant message. */
export function runSucceeded(messages: readonly AgentMessage[]): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = asRecord(messages[index]);
		if (message?.role !== "assistant") continue;
		return message.stopReason !== "error" && message.stopReason !== "aborted";
	}
	return false;
}

/** Sanitizes a session identifier so it cannot escape the dump root. */
export function sanitizeSessionKey(value: string): string {
	const sanitized = redactSensitiveText(value)
		.replace(/[\0-\x1f/\\]/g, "_")
		.replace(/^\.+/, "")
		.slice(0, 200);
	return sanitized || "unknown";
}

/** Creates a session directory and a unique UTC turn directory beneath it. */
export function createTurnDirectory(
	dumpDir: string,
	sessionId: string,
	now = new Date(),
): TurnDirectory {
	mkdirSync(dumpDir, { recursive: true });
	const sessionKey = sanitizeSessionKey(sessionId);
	const sessionDir = join(dumpDir, sessionKey);
	mkdirSync(sessionDir, { recursive: true });

	const timestamp = now.toISOString();
	for (let suffix = 1; ; suffix += 1) {
		const turnName = suffix === 1 ? timestamp : `${timestamp}-${suffix}`;
		const turnDir = join(sessionDir, turnName);
		try {
			mkdirSync(turnDir);
			return {
				sessionKey,
				sessionDir,
				turnName,
				turnDir,
				relativeDir: `${sessionKey}/${turnName}`,
			};
		} catch (error) {
			const code = asRecord(error)?.code;
			if (code !== "EEXIST") throw error;
		}
	}
}

/** Writes normalized message files with sequence numbers continuing from `startSequence`. */
function writeMessageFiles(
	turnDir: string,
	messages: NormalizedDumpInput["messages"],
	startSequence: number,
	filePrefix = "",
): MessageWriteResult {
	mkdirSync(turnDir, { recursive: true });
	let sequence = startSequence;
	let chars = 0;

	for (const message of messages) {
		const filename = `${filePrefix}${String(sequence).padStart(4, "0")}-${messageRole(message)}.txt`;
		const content = redactSensitiveText(message.text);
		writeFileSync(join(turnDir, filename), content, "utf8");
		chars += content.length;
		sequence += 1;
	}

	return { messages: messages.length, chars, nextSequence: sequence };
}

/** Writes raw Pi work messages after rendering them into the common message-file shape. */
export function writeMessages(
	turnDir: string,
	messages: readonly AgentMessage[],
	startSequence: number,
): MessageWriteResult {
	return writeMessageFiles(
		turnDir,
		messages.map((message) => ({ role: messageRole(message), text: renderMessage(message) })),
		startSequence,
	);
}

/** Writes one normalized input event, optionally grouping files under a request prefix. */
export function writeInput(
	turnDir: string,
	input: NormalizedDumpInput,
	startSequence = 0,
	filePrefix = "",
): InputWriteResult {
	mkdirSync(turnDir, { recursive: true });
	const prefix = filePrefix.replace(/[^a-zA-Z0-9_-]/g, "_");
	const messages = writeMessageFiles(turnDir, input.messages, startSequence, prefix);

	let paramsChars = 0;
	let paramsFilename: string | undefined;
	if (input.params !== undefined) {
		const content = `${safeJsonStringify(input.params)}\n`;
		paramsFilename = `${prefix}params.json`;
		writeFileSync(join(turnDir, paramsFilename), content, "utf8");
		paramsChars = content.length;
	}

	return {
		messages: messages.messages,
		chars: messages.chars + paramsChars,
		nextSequence: messages.nextSequence,
		paramsChars,
		...(paramsFilename === undefined ? {} : { paramsFilename }),
	};
}

/** Writes the clean terminal assistant reply as the next numbered turn file. */
export function writeOutputFile(
	turnDir: string,
	output: string,
	sequence: number,
): MessageWriteResult {
	mkdirSync(turnDir, { recursive: true });
	const content = redactSensitiveText(output);
	writeFileSync(join(turnDir, `${String(sequence).padStart(4, "0")}-output.txt`), content, "utf8");
	return { messages: 0, chars: content.length, nextSequence: sequence + 1 };
}

/** Writes auxiliary JSON metadata into a turn directory. */
export function writeMetadataFile(turnDir: string, filename: string, value: unknown): void {
	mkdirSync(turnDir, { recursive: true });
	writeFileSync(join(turnDir, filename), `${safeJsonStringify(value)}\n`, "utf8");
}

/** Converts one optional row value into a tab-safe index cell. */
function formatCell(value: string | number | boolean | undefined): string {
	if (value === undefined) return "";
	return redactSensitiveText(String(value)).replace(/[\t\r\n]/g, " ");
}

/** Converts an index row into its fixed column order. */
function formatIndexRow(row: IndexRow): string {
	return [
		row.kind,
		row.timestamp,
		row.runId,
		row.sessionId,
		row.provider,
		row.model,
		row.messages,
		row.images,
		row.chars,
		row.ok,
		row.ms,
		row.dir,
	]
		.map(formatCell)
		.join("\t");
}

/** Appends index rows, retaining an existing compatible header. */
export function appendIndexRows(sessionDir: string, rows: readonly IndexRow[]): void {
	if (rows.length === 0) return;
	const indexPath = join(sessionDir, "index.tsv");
	const header = INDEX_COLUMNS.join("\t");
	const body = rows.map(formatIndexRow).join("\n");

	if (existsSync(indexPath)) {
		const existing = readFileSync(indexPath, "utf8");
		const firstLine = existing.split(/\r?\n/, 1)[0];
		if (firstLine === header) {
			const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
			appendFileSync(indexPath, `${separator}${body}\n`, "utf8");
			return;
		}
		writeFileSync(indexPath, `${header}\n${body}\n`, "utf8");
		return;
	}

	writeFileSync(indexPath, `${header}\n${body}\n`, "utf8");
}

/** Reads aggregate byte and newest-mtime information for a tree. */
function inspectTree(root: string): { bytes: number; newestMtimeMs: number } {
	let bytes = 0;
	let newestMtimeMs = 0;
	const stack = [root];

	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) continue;
		const currentStat = lstatSync(current);
		newestMtimeMs = Math.max(newestMtimeMs, currentStat.mtimeMs);
		if (!currentStat.isDirectory()) {
			bytes += currentStat.size;
			continue;
		}
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			stack.push(join(current, entry.name));
		}
	}

	return { bytes, newestMtimeMs };
}

interface TurnPath {
	sessionDir: string;
	turnDir: string;
	turnName: string;
}

/** Lists only Pi-created timestamp turn directories under the dump root. */
function listTurnDirectories(dumpDir: string): TurnPath[] {
	if (!existsSync(dumpDir)) return [];
	const turns: TurnPath[] = [];

	for (const sessionEntry of readdirSync(dumpDir, { withFileTypes: true })) {
		if (!sessionEntry.isDirectory()) continue;
		const sessionDir = join(dumpDir, sessionEntry.name);
		for (const turnEntry of readdirSync(sessionDir, { withFileTypes: true })) {
			if (!turnEntry.isDirectory() || !TURN_DIRECTORY_PATTERN.test(turnEntry.name)) continue;
			turns.push({
				sessionDir,
				turnDir: join(sessionDir, turnEntry.name),
				turnName: turnEntry.name,
			});
		}
	}

	return turns;
}

/** Returns whether an index path is a safe two-component relative turn path. */
function isSafeIndexDir(value: string): boolean {
	if (value.length === 0 || isAbsolute(value) || value.includes("\0")) return false;
	const parts = value.split(/[\\/]/);
	return parts.length === 2 && parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

/** Removes stale index rows and rows whose turn directory no longer exists. */
function trimIndexFile(
	dumpDir: string,
	sessionDir: string,
	maxAgeMs: number,
	now: number,
): void {
	const indexPath = join(sessionDir, "index.tsv");
	if (!existsSync(indexPath)) return;

	const lines = readFileSync(indexPath, "utf8").split(/\r?\n/);
	const header = INDEX_COLUMNS.join("\t");
	if (lines[0] !== header) {
		rmSync(indexPath, { force: true });
		return;
	}

	const cutoff = now - maxAgeMs;
	const rows = lines.slice(1).filter((line) => {
		if (line.length === 0) return false;
		const columns = line.split("\t");
		if (columns.length !== INDEX_COLUMNS.length) return false;
		const timestampMs = Date.parse(columns[1]);
		if (!Number.isFinite(timestampMs) || timestampMs < cutoff) return false;
		const relativeDir = columns[11];
		return isSafeIndexDir(relativeDir) && existsSync(resolve(dumpDir, relativeDir));
	});

	if (rows.length === 0) {
		rmSync(indexPath, { force: true });
		return;
	}
	writeFileSync(indexPath, `${header}\n${rows.join("\n")}\n`, "utf8");
}

/** Removes empty session directories after their final retained turn is pruned. */
function cleanupEmptySessions(dumpDir: string): void {
	if (!existsSync(dumpDir)) return;
	for (const entry of readdirSync(dumpDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const sessionDir = join(dumpDir, entry.name);
		const hasTurns = readdirSync(sessionDir, { withFileTypes: true }).some(
			(child) => child.isDirectory() && TURN_DIRECTORY_PATTERN.test(child.name),
		);
		if (hasTurns) continue;
		rmSync(join(sessionDir, "index.tsv"), { force: true });
		try {
			rmdirSync(sessionDir);
		} catch {
			// Leave non-empty user-created content in place.
		}
	}
}

/**
 * Enforces age and byte retention at turn-directory granularity, then trims
 * indexes so they never refer to a pruned turn.
 */
export function pruneDump(
	config: TurnDumpConfig,
	now = Date.now(),
	preserveTurnDir?: string,
): void {
	const dumpDir = config.dumpDir;
	if (dumpDir === undefined || !existsSync(dumpDir)) return;
	const preserved = preserveTurnDir === undefined ? undefined : resolve(preserveTurnDir);

	const cutoff = now - config.maxAgeMs;
	for (const turn of listTurnDirectories(dumpDir)) {
		if (preserved !== undefined && resolve(turn.turnDir) === preserved) continue;
		const stats = inspectTree(turn.turnDir);
		if (stats.newestMtimeMs < cutoff) {
			rmSync(turn.turnDir, { recursive: true, force: true });
		}
	}

	let turns = listTurnDirectories(dumpDir);
	let totalBytes = inspectTree(dumpDir).bytes;
	if (totalBytes > config.maxBytes) {
		turns = turns.sort((left, right) => left.turnName.localeCompare(right.turnName));
		for (const turn of turns) {
			if (totalBytes <= config.maxBytes) break;
			if (preserved !== undefined && resolve(turn.turnDir) === preserved) continue;
			const stats = inspectTree(turn.turnDir);
			rmSync(turn.turnDir, { recursive: true, force: true });
			totalBytes -= stats.bytes;
		}
	}

	cleanupEmptySessions(dumpDir);
	for (const sessionEntry of readdirSync(dumpDir, { withFileTypes: true })) {
		if (!sessionEntry.isDirectory()) continue;
		trimIndexFile(dumpDir, join(dumpDir, sessionEntry.name), config.maxAgeMs, now);
	}

	// Index trimming can make room after the byte pass; remove the now-empty session shell.
	cleanupEmptySessions(dumpDir);
}
