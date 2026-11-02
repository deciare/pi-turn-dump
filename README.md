# pi-turn-dump

`pi-turn-dump` is an observe-only [Pi](https://pi.dev) extension that writes whole
agent turns to local files for debugging. One directory contains the turn input
or provider request, the model's tool work and intermediate messages, and the
terminal reply.

It is intended to be inert except while debugging. Point `dumpDir` at a private,
ephemeral directory, reproduce the problem, inspect the files, then remove
`dumpDir` from the configuration again.

The extension never returns a mutation from a hook. The worst dump-side failure
is a warning and missing files; it does not block a tool, alter a prompt, or
change the reply.

## Install

For a local checkout, link or copy this directory into Pi's extension directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)" ~/.pi/agent/extensions/turn-dump
```

Pi can also load a git package once the repository is published:

```bash
pi install git:github.com/deciare/pi-turn-dump
```

Pi reloads extensions from session-backed extension locations with `/reload`.

## Configuration

Configuration lives in its own file, not in Pi's `settings.json`:

- Global: `~/.pi/agent/turn-dump.json`
- Trusted project override: `<project>/.pi/turn-dump.json`

Project values override global values key by key. The global file is used when
the project is not trusted. No `hooks.allowConversationAccess` setting is needed;
these are ordinary Pi extension events.

```json
{
  "dumpDir": "/tmp/pi-turn-dump",
  "source": "input",
  "maxBytes": 67108864,
  "maxAgeMs": 21600000
}
```

| Key | Type | Default | Meaning |
|---|---|---:|---|
| `dumpDir` | string | unset | Dump root. Unset is inert. Relative paths resolve against the config file that declares them. |
| `source` | `"input"` or `"request"` | `"input"` | Capture the normalized model transcript, or the provider-native request payload. |
| `maxBytes` | non-negative integer | `67108864` | Total byte cap for retained dumps, including indexes. |
| `maxAgeMs` | non-negative integer | `21600000` | Maximum age for turn directories and index rows. |

Unknown keys and invalid values reject that config file with a warning. A
mistyped key therefore cannot silently leave the dumper looking enabled.

## Sources

### `source: "input"` (default)

Captures the first `context_with_system` event of the settled agent run. This is
the full transcript that Pi is preparing for the model after its context hooks:
the system prompt and tool declarations, history, the triggering user or custom
message, and extension-injected context.

The files remain Pi agent messages, not provider-specific wire JSON. Message
text, thinking, assistant tool calls, tool results, compaction summaries, branch
summaries, shell commands, and custom messages are rendered into their own
numbered files.

### `source: "request"`

Captures every `before_provider_request` payload in the run as JSON. This is the
provider-specific body after Pi has serialized the transcript, including
provider message formatting and sampling parameters. Payloads differ by provider
and API, so request-mode files remain raw JSON instead of pretending every
provider has the same message shape.

Request mode writes `request-0001.json`, `request-0002.json`, and so on because a
single Pi agent run can issue several model requests while executing tools.
Credential-shaped keys are redacted a second time by this extension.

Provider hooks run only when the transport exposes them. If request mode sees a
model context but no payload hook in a session, it emits one warning instead of
silently writing a request-free dump.

## Output layout

```text
<dumpDir>/
  <session-id>/
    2026-11-01T12:34:56.789Z/       one directory per settled agent run
      0000-system.txt
      0001-user.txt
      0002-assistant.txt
      0003-toolresult.txt
      0004-assistant.txt
      0005-output.txt
      request-0001.json             request source only
      run-meta.json
    index.tsv
```

- Sequence numbers continue through the input and work files, then end at
  `<sequence>-output.txt`.
- Roles are lowercased and restricted to `[a-z0-9_-]`. A missing role is
  `unknown`.
- The terminal reply is written twice by design: as the final assistant message
  in the work sequence and as a clean `output.txt` after it.
- `run-meta.json` records the internal run ID, final outcome, duration, and the
  last assistant message.
- Session IDs retain colons but replace path separators and control characters.
  They are capped at 200 characters so they cannot escape `dumpDir`.

### Work-message boundary

Pi's `agent_end` fires for a low-level run and may be followed by automatic
retries, compaction recovery, queued messages, or another low-level run. The
extension accumulates each `agent_end` message list until `agent_settled`, so a
single directory covers the whole settled turn.

Pi's `agent_end.messages` contains only that low-level run's new messages, not
the history again. History is captured once by the input event; tool calls,
results, injected context, and terminal messages are appended as they complete.

### `index.tsv`

The index has one row per input, request, low-level run, and output event:

| Column | Meaning |
|---|---|
| `kind` | `input`, `request`, `turn`, or `output` |
| `timestamp` | ISO-8601 write time |
| `runId` | Internal ID for the settled dump |
| `sessionId` | Pi session ID |
| `provider` / `model` | Request model when available |
| `messages` | Files written for input or a low-level run |
| `images` | Images in the input transcript |
| `chars` | Characters written by that event |
| `ok` | Low-level run ended with a non-error assistant message |
| `ms` | Low-level run wall-clock duration when available |
| `dir` | Turn directory relative to `dumpDir` |

## Retention

Retention runs after every dump write and at finalization:

1. Turn directories whose newest file is older than `maxAgeMs` are removed.
2. If the tree still exceeds `maxBytes`, the oldest complete turn directories
   are removed first.
3. Empty session directories and their indexes are removed.
4. Index rows older than the age limit, or pointing at a removed directory, are
   dropped.

Pruning is always at whole-turn-directory granularity. A turn's files are never
split across a prune. The active turn is protected from intermediate retention
passes and is reconsidered as a whole at finalization.

## Failure behavior

Every event handler catches dump errors and reports `turn-dump: ... failed: ...`
with `console.warn`. A full disk, unwritable directory, malformed payload, or
retention error does not escape into Pi's agent loop.

The extension starts a directory for each run that reaches
`before_agent_start`; a run that ends before its first model request can
therefore contain only final metadata and an empty output file.

## Privacy

This extension writes raw conversation data in cleartext: system prompts,
history, user messages, tool arguments, tool results, injected context, provider
payloads, and replies. Request JSON also has a defensive second pass for
credential-shaped keys, but message content can still contain secrets supplied
by users, tools, or providers.

Use a private temporary directory and delete it after debugging.

## Differences from the OpenClaw design

- Pi stores extension settings in `turn-dump.json`; this implementation uses the
  agent-level file and an optional trusted project override.
- Pi has no separate conversation-access permission flag for these events.
- Pi's closest input seam is `context_with_system`, the full normalized
  transcript immediately before provider serialization. There is no immutable
  stock hook for an untouched pre-transform harness snapshot.
- Pi's `before_provider_request` observes the provider-native payload but is
  itself part of a transform chain. An extension loaded after `turn-dump` can
  still modify the payload after this extension observes it.
- Pi's `agent_end` is per low-level run, not per user turn. Accumulation through
  `agent_settled` is required to keep retries and recovery in one dump.
- Request mode stores raw provider JSON and can contain multiple requests per
  turn, rather than OpenClaw's single `request-params.txt` shape.

## Test

The writer and configuration tests use only `node:` built-ins and temporary
directories. They do not start a Pi session or touch a live dump directory.

```bash
npm test
npm run typecheck
```
