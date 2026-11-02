/**
 * pi-turn-dump
 *
 * @license
 * Copyright 2026 deciare
 * SPDX-License-Identifier: MIT
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { countImages, messageRole, renderContent, renderMessage, safeJsonStringify } from "./dump.ts";

/** One normalized message handed from a Pi hook to the dump writer. */
export interface NormalizedDumpMessage {
	role: string;
	text: string;
}

/** Input shape shared by transcript and provider-request capture. */
export interface NormalizedDumpInput {
	kind: "input" | "request";
	messages: NormalizedDumpMessage[];
	images?: number;
	/** Non-message provider request fields, when available. */
	params?: unknown;
}

const REQUEST_MESSAGE_KEYS = ["messages", "input", "contents", "prompt"] as const;
const REQUEST_SYSTEM_KEYS = ["system", "instructions"] as const;

/** Returns a plain object view of an unknown value. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Converts Pi's full model transcript into the writer's common input shape. */
export function normalizeTranscriptInput(messages: readonly AgentMessage[]): NormalizedDumpInput {
	return {
		kind: "input",
		messages: messages.map((message) => ({
			role: messageRole(message),
			text: renderMessage(message),
		})),
		images: countImages(messages),
	};
}

/** Maps provider role names onto the reader-facing roles used by dump files. */
function normalizeProviderRole(value: unknown): string {
	if (typeof value !== "string") return "message";
	switch (value.toLowerCase()) {
		case "model":
			return "assistant";
		case "function_call":
		case "tool_use":
		case "toolcall":
			return "assistant";
		case "function_call_output":
		case "tool_result":
		case "toolresult":
			return "toolresult";
		default:
			return value;
	}
}

/** Returns the role represented by one provider request item. */
function providerItemRole(value: unknown): string {
	const item = asRecord(value);
	if (item === undefined) return "message";
	if (item.role !== undefined) return normalizeProviderRole(item.role);
	return normalizeProviderRole(item.type);
}

/** Renders one provider request item without assuming a single provider schema. */
function providerItemText(value: unknown): string {
	const item = asRecord(value);
	if (item === undefined) return renderContent(value);
	if (item.content !== undefined) return renderContent(item.content);
	if (item.parts !== undefined) return renderContent(item.parts);
	if (item.output !== undefined) return renderContent(item.output);
	return renderContent(item);
}

/** Copies a provider payload and strips the fields represented as message files. */
function nonMessageParams(payload: Record<string, unknown>): Record<string, unknown> | undefined {
	const params = { ...payload };
	for (const key of [...REQUEST_MESSAGE_KEYS, ...REQUEST_SYSTEM_KEYS]) delete params[key];
	return Object.keys(params).length === 0 ? undefined : params;
}

/** Extracts provider messages, or falls back to one readable representation of the payload. */
function providerMessages(payload: Record<string, unknown>): NormalizedDumpMessage[] {
	const messages: NormalizedDumpMessage[] = [];

	for (const key of REQUEST_SYSTEM_KEYS) {
		const system = payload[key];
		if (system === undefined) continue;
		const text = renderContent(system);
		if (text.length > 0) messages.push({ role: "system", text });
	}

	for (const key of REQUEST_MESSAGE_KEYS) {
		const value = payload[key];
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) {
				messages.push({
					role: providerItemRole(item),
					text: providerItemText(item),
				});
			}
		} else {
			messages.push({
				role: key === "prompt" ? "user" : "message",
				text: renderContent(value),
			});
		}
		break;
	}

	return messages.length > 0
		? messages
		: [{ role: "request", text: safeJsonStringify(payload, false) }];
}

/**
 * Converts a provider-native request payload into the same message files used
 * for transcript input, keeping all non-message fields as request parameters.
 */
export function normalizeProviderRequest(payload: unknown): NormalizedDumpInput {
	const request = asRecord(payload);
	if (request === undefined) {
		return {
			kind: "request",
			messages: [{ role: "request", text: safeJsonStringify(payload) }],
		};
	}
	const hasMessageField = [...REQUEST_MESSAGE_KEYS, ...REQUEST_SYSTEM_KEYS].some(
		(key) => request[key] !== undefined,
	);
	const params = hasMessageField ? nonMessageParams(request) : undefined;
	return {
		kind: "request",
		messages: providerMessages(request),
		...(params === undefined ? {} : { params }),
	};
}
