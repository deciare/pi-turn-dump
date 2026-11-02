/**
 * pi-turn-dump
 *
 * @license
 * Copyright 2026 deciare
 * SPDX-License-Identifier: MIT
 */

import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadTurnDumpConfig, type TurnDumpConfig } from "./src/config.ts";
import {
	appendIndexRows,
	createTurnDirectory,
	lastAssistantText,
	pruneDump,
	runSucceeded,
	type IndexRow,
	type TurnDirectory,
	writeInput,
	writeMessages,
	writeMetadataFile,
	writeOutputFile,
} from "./src/dump.ts";
import {
	normalizeProviderRequest,
	normalizeTranscriptInput,
	type NormalizedDumpInput,
} from "./src/input.ts";
import { redactSensitiveText } from "./src/redact.ts";

/** Mutable state for the top-level agent run currently being dumped. */
interface ActiveTurn {
	runId: string;
	sessionId: string;
	directory: TurnDirectory;
	startedAtMs: number;
	nextSequence: number;
	inputWritten: boolean;
	requestCount: number;
	contextSeenThisRun: boolean;
	requestSeenThisRun: boolean;
	currentRunStartedAtMs?: number;
	rows: IndexRow[];
	workMessages: AgentMessage[];
	outcome?: "completed" | "aborted" | "error";
}

/** Reports a dump failure without disturbing the agent turn. */
function warn(message: string): void {
	console.warn(`turn-dump: ${redactSensitiveText(message)}`);
}

/** Formats an unknown thrown value for a warning. */
function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Runs one observe-only dump operation and catches every write-side failure. */
function safely(operation: () => void, label: string): void {
	try {
		operation();
	} catch (error) {
		warn(`${label} failed: ${describeError(error)}`);
	}
}

/** Returns provider/model labels for the current request context. */
function modelFields(ctx: ExtensionContext): Pick<IndexRow, "provider" | "model"> {
	return ctx.model === undefined
		? {}
		: {
				provider: ctx.model.provider,
				model: ctx.model.id,
			};
}

/** Returns a timestamp for index rows. */
function nowIso(): string {
	return new Date().toISOString();
}

/** Registers an observe-only turn dumper with Pi. */
export default function turnDumpExtension(pi: ExtensionAPI): void {
	let config: TurnDumpConfig = {
		maxBytes: 67_108_864,
		maxAgeMs: 21_600_000,
		source: "input",
	};
	let active: ActiveTurn | undefined;
	let warnedRequestUnavailable = new Set<string>();

	/** Writes any normalized input event through the same row and retention path. */
	const captureInput = (
		state: ActiveTurn,
		input: NormalizedDumpInput,
		ctx: ExtensionContext,
		options: { advanceSequence: boolean; filePrefix?: string },
	): void => {
		const written = writeInput(
			state.directory.turnDir,
			input,
			options.advanceSequence ? state.nextSequence : 0,
			options.filePrefix,
		);
		if (options.advanceSequence) state.nextSequence = written.nextSequence;
		state.rows.push({
			kind: input.kind,
			timestamp: nowIso(),
			runId: state.runId,
			sessionId: state.sessionId,
			...modelFields(ctx),
			messages: written.messages,
			...(input.images === undefined ? {} : { images: input.images }),
			chars: written.chars,
			dir: state.directory.relativeDir,
		});
	};

	/** Finalizes a partial run during session teardown. */
	const finalize = (state: ActiveTurn, aborted: boolean, outcome?: ActiveTurn["outcome"]): void => {
		safely(() => {
			const finalOutcome = aborted ? "aborted" : (outcome ?? state.outcome ?? "completed");
			const output = lastAssistantText(state.workMessages);
			const outputWrite = writeOutputFile(state.directory.turnDir, output, state.nextSequence);
			state.nextSequence = outputWrite.nextSequence;
			const outputRow: IndexRow = {
				kind: "output",
				timestamp: nowIso(),
				runId: state.runId,
				sessionId: state.sessionId,
				...modelFieldsForState(state),
				messages: 0,
				chars: outputWrite.chars,
				dir: state.directory.relativeDir,
			};
			state.rows.push(outputRow);

			const terminalAssistant = findLastAssistant(state.workMessages);
			safely(
				() =>
					writeMetadataFile(state.directory.turnDir, "run-meta.json", {
						runId: state.runId,
						sessionId: state.sessionId,
						outcome: finalOutcome,
						durationMs: Date.now() - state.startedAtMs,
						assistant: terminalAssistant,
					}),
				"write run metadata",
			);

			const finalizedRows = state.rows.map((row) =>
				row.kind === "turn" && row.ok === undefined ? { ...row, ok: finalOutcome === "completed" } : row,
			);
			appendIndexRows(state.directory.sessionDir, finalizedRows);
			pruneDump(config);
		}, "finalize turn");
	};

	pi.on("session_start", (_event, ctx) => {
		active = undefined;
		warnedRequestUnavailable = new Set<string>();
		const loaded = loadTurnDumpConfig({
			agentDir: getAgentDir(),
			configDirName: CONFIG_DIR_NAME,
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
		});
		config = loaded.config;
		for (const error of loaded.errors) warn(error);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		safely(() => {
			if (config.dumpDir === undefined) return;
			if (active !== undefined) finalize(active, true, "aborted");

			const sessionId = ctx.sessionManager.getSessionId();
			active = {
				runId: randomUUID(),
				sessionId,
				directory: createTurnDirectory(config.dumpDir, sessionId),
				startedAtMs: Date.now(),
				nextSequence: 0,
				inputWritten: false,
				requestCount: 0,
				contextSeenThisRun: false,
				requestSeenThisRun: false,
				rows: [],
				workMessages: [],
			};
		}, "start turn");
	});

	pi.on("agent_start", () => {
		if (active === undefined) return;
		active.currentRunStartedAtMs = Date.now();
		active.contextSeenThisRun = false;
		active.requestSeenThisRun = false;
	});

	pi.on("context_with_system", (event, ctx) => {
		if (active === undefined) return;
		if (config.source === "request") {
			active.contextSeenThisRun = true;
			return;
		}
		if (active.inputWritten) return;
		safely(() => {
			const state = active;
			if (state === undefined) return;
			const messages = structuredClone(event.messages);
			captureInput(state, normalizeTranscriptInput(messages), ctx, { advanceSequence: true });
			state.inputWritten = true;
			pruneDump(config, Date.now(), state.directory.turnDir);
		}, "write input");
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (active === undefined || config.source !== "request") return;
		safely(() => {
			const state = active;
			if (state === undefined) return;
			state.requestCount += 1;
			state.requestSeenThisRun = true;
			const prefix = `request-${String(state.requestCount).padStart(4, "0")}-`;
			captureInput(state, normalizeProviderRequest(event.payload), ctx, {
				advanceSequence: false,
				filePrefix: prefix,
			});
			pruneDump(config, Date.now(), state.directory.turnDir);
		}, "write provider request");
	});

	pi.on("agent_end", (event) => {
		if (active === undefined) return;
		safely(() => {
			const state = active;
			if (state === undefined) return;
			const messages = structuredClone(event.messages);
			const written = writeMessages(state.directory.turnDir, messages, state.nextSequence);
			state.nextSequence = written.nextSequence;
			state.workMessages.push(...messages);
			const elapsed =
				state.currentRunStartedAtMs === undefined ? undefined : Date.now() - state.currentRunStartedAtMs;
			state.rows.push({
				kind: "turn",
				timestamp: nowIso(),
				runId: state.runId,
				sessionId: state.sessionId,
				messages: written.messages,
				chars: written.chars,
				ok: runSucceeded(messages),
				...(elapsed === undefined ? {} : { ms: elapsed }),
				dir: state.directory.relativeDir,
			});
			state.currentRunStartedAtMs = undefined;
			if (
				config.source === "request" &&
				state.contextSeenThisRun &&
				!state.requestSeenThisRun &&
				!warnedRequestUnavailable.has(state.sessionId)
			) {
				warnedRequestUnavailable.add(state.sessionId);
				warn(
					"request source observed a model context but the provider did not expose before_provider_request",
				);
			}
			pruneDump(config, Date.now(), state.directory.turnDir);
		}, "write turn messages");
	});

	pi.on("agent_before_settle", (event) => {
		if (active !== undefined) active.outcome = event.outcome;
	});

	pi.on("agent_settled", (event) => {
		if (active === undefined) return;
		const state = active;
		active = undefined;
		finalize(state, event.aborted, event.aborted ? "aborted" : state.outcome);
	});

	pi.on("session_shutdown", () => {
		if (active === undefined) return;
		const state = active;
		active = undefined;
		finalize(state, true, "aborted");
	});
}

/** Finds the final assistant message without narrowing the agent message union. */
function findLastAssistant(messages: readonly AgentMessage[]): unknown {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as unknown;
		if (typeof message === "object" && message !== null && "role" in message && message.role === "assistant") {
			return message;
		}
	}
	return undefined;
}

/** Reads provider/model labels back from persisted work messages. */
function modelFieldsForState(state: ActiveTurn): Pick<IndexRow, "provider" | "model"> {
	const assistant = findLastAssistant(state.workMessages);
	if (typeof assistant !== "object" || assistant === null || !("provider" in assistant) || !("model" in assistant)) {
		return {};
	}
	return {
		...(typeof assistant.provider === "string" ? { provider: assistant.provider } : {}),
		...(typeof assistant.model === "string" ? { model: assistant.model } : {}),
	};
}
