/**
 * pi-turn-dump
 *
 * @license
 * Copyright 2026 deciare
 * SPDX-License-Identifier: MIT
 */

/** Marker written in place of a detected credential. */
export const REDACTED = "[REDACTED]";

/**
 * Credential-shaped suffixes. Matching is on normalized keys so apiKey,
 * api_key, API-KEY, and XApiKey all resolve to the same decision.
 */
const SENSITIVE_KEY_PATTERN =
	/(?:authorization|proxyauthorization|apikey|xapikey|accesskey|accesskeyid|accountkey|secretaccesskey|secretkey|privatekey|sharedaccesskey|sharedaccesssignature|subscriptionkey|functionskey|sessiontoken|accesstoken|refreshtoken|idtoken|authtoken|bearertoken|securitytoken|token|password|passwd|clientsecret|credential|credentials|cookie|setcookie|signature|sig|secret)$/;

/** Key-like names with an auth purpose, used inside free-form text. */
const SENSITIVE_NAME = String.raw`(?:[A-Za-z0-9]+[_-])*(?:authorization|api[_-]?key|x[_-]?api[_-]?key|access[_-]?key(?:[_-]?id)?|account[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|private[_-]?key|shared[_-]?access[_-]?key|shared[_-]?access[_-]?signature|subscription[_-]?key|functions[_-]?key|session[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|security[_-]?token|token|password|passwd|client[_-]?secret|credential(?:s)?|cookie|set[_-]?cookie|signature|sig)`;

/** HTTP headers whose complete value is sensitive even when quoted inline. */
const SENSITIVE_HEADER_PATTERN =
	/\b((?:proxy-)?authorization|x-api-key|api-key|cookie|set-cookie)\s*:\s*[^\r\n'"]+/gi;

/** Common provider and package-registry token formats. */
const TOKEN_PATTERN =
	/\b(?:sk-[A-Za-z0-9_-]{6,}|xai-[A-Za-z0-9_-]{10,}|gsk_[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|glpat-[A-Za-z0-9_-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|A(?:KIA|SIA)[0-9A-Z]{16}|hf_[A-Za-z0-9]{10,}|npm_[A-Za-z0-9]{10,}|pypi-[A-Za-z0-9_-]{10,})\b/g;

/** JSON Web Tokens have three base64url segments headed by a JSON object. */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/** A private-key PEM block must be removed as a complete unit. */
const PRIVATE_KEY_PATTERN =
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/** Credentials embedded in a URL's user-info component. */
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

/** Authorization schemes and their often-opaque credential value. */
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** A quoted value assigned to a credential-shaped name. */
const QUOTED_ASSIGNMENT_PATTERN = new RegExp(
	String.raw`((?:["']?${SENSITIVE_NAME}["']?)\s*(?::|=)(?!=)\s*)(["'])([\s\S]*?)\2`,
	"gi",
);

/** An unquoted value assigned to a credential-shaped name. */
const ASSIGNMENT_PATTERN = new RegExp(
	String.raw`((?:["']?${SENSITIVE_NAME}["']?)\s*(?::|=)(?!=)\s*)(?!["'])([^\s,;}\]]+)`,
	"gi",
);

/** Credential assignments that own the remainder of a line, including spaces. */
const ASSIGNMENT_LINE_PATTERN = new RegExp(
	String.raw`(^|\n)([ \t]*(?:(?:export|const|let|var)\s+)?["']?${SENSITIVE_NAME}["']?\s*(?::|=)(?!=)\s*)[^\r\n]*`,
	"gi",
);

/** A command-line flag carrying a credential value. */
const FLAG_PATTERN = new RegExp(
	String.raw`((?:^|\s)--?${SENSITIVE_NAME}\s+)(["']?)([^\s"']+)\2`,
	"gi",
);

/** Returns whether a structured field name identifies a credential. */
export function isSensitiveKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	return normalized.length > 0 && (normalized === "key" || SENSITIVE_KEY_PATTERN.test(normalized));
}

/** Redacts known credential forms from free-form text. */
export function redactSensitiveText(text: string): string {
	const redactedPrefix = REDACTED.slice(0, -1);
	return text
		.replace(PRIVATE_KEY_PATTERN, REDACTED)
		.replace(URL_CREDENTIAL_PATTERN, `$1${REDACTED}@`)
		.replace(TOKEN_PATTERN, REDACTED)
		.replace(JWT_PATTERN, REDACTED)
		.replace(AUTH_SCHEME_PATTERN, `$1 ${REDACTED}`)
		.replace(SENSITIVE_HEADER_PATTERN, `$1: ${REDACTED}`)
		.replace(QUOTED_ASSIGNMENT_PATTERN, (match, prefix: string, quote: string, value: string) =>
			value === REDACTED ? match : `${prefix}${quote}${REDACTED}${quote}`,
		)
		.replace(ASSIGNMENT_PATTERN, (match, prefix: string, value: string) =>
			value.startsWith(redactedPrefix) ? match : `${prefix}${REDACTED}`,
		)
		.replace(ASSIGNMENT_LINE_PATTERN, (match, lineStart: string, prefix: string) =>
			match.trimEnd().endsWith(REDACTED) ? match : `${lineStart}${prefix}${REDACTED}`,
		)
		.replace(FLAG_PATTERN, (match, prefix: string, quote: string, value: string) =>
			value === REDACTED ? match : `${prefix}${quote}${REDACTED}${quote}`,
		);
}

/** Recursively clones JSON-like data while redacting keys and recognized secret values. */
export function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "function" || typeof value === "symbol") return String(value);
	if (typeof value === "string") return redactSensitiveText(value);
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);

	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, seen));

	const source = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(source)) {
		output[key] = isSensitiveKey(key) ? REDACTED : redactSecrets(entry, seen);
	}
	return output;
}

/** Formats unknown data as JSON while applying credential redaction. */
export function safeJsonStringify(value: unknown, pretty = true): string {
	try {
		const serialized = JSON.stringify(redactSecrets(value), null, pretty ? 2 : undefined);
		return serialized === undefined ? "null" : serialized;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return JSON.stringify(`<unserializable: ${redactSensitiveText(message)}>`);
	}
}
