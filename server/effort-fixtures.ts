/** Sanitized transcript builders. These are the parser contract: the implementation must not
 * depend on this machine continuing to have the same shapes as the live corpus.
 *
 * Every builder embeds `SENSITIVE_SENTINEL` in the places real transcripts carry reasoning text,
 * prompts, responses, commands, and file contents. Any test that finds the sentinel downstream
 * has found a privacy regression. */
export const SENSITIVE_SENTINEL = "TRAP-do-not-persist-9f3a1c";

/** Each built event is a distinct response by default. A test that wants Claude's repeated-
 * response shape opts in by passing the same `requestId`/`messageId` to consecutive events. */
let responseCounter = 0;

type ClaudeUsage = {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
};

export function claudeAssistant(options: {
  effort?: string | null;
  model?: string | null;
  timestamp?: string | null;
  usage?: ClaudeUsage | null;
  /** Set both to the same values on consecutive events to reproduce Claude's repeated-response
   * shape, where one logical answer is written out several times with the same usage. */
  requestId?: string;
  messageId?: string;
}) {
  const row: Record<string, unknown> = {
    type: "assistant",
    uuid: "00000000-0000-4000-8000-000000000000",
    sessionId: "fixture-session",
    cwd: "/fixture/project",
    requestId: options.requestId ?? `req_${++responseCounter}`,
    message: {
      role: "assistant",
      id: options.messageId ?? `msg_${responseCounter}`,
      ...(options.model === undefined ? { model: "claude-opus-5" } : options.model === null ? {} : { model: options.model }),
      content: [{ type: "text", text: SENSITIVE_SENTINEL }],
      ...(options.usage === null ? {} : { usage: options.usage ?? { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 } }),
    },
  };
  if (options.effort !== null && options.effort !== undefined) row.effort = options.effort;
  if (options.timestamp !== null) row.timestamp = options.timestamp ?? "2026-07-01T15:00:00.000Z";
  return JSON.stringify(row);
}

export function claudeUser(text = SENSITIVE_SENTINEL) {
  return JSON.stringify({ type: "user", timestamp: "2026-07-01T15:00:00.000Z", message: { role: "user", content: [{ type: "text", text }] } });
}

export function codexTurnContext(options: { effort?: string | null; model?: string; timestamp?: string }) {
  return JSON.stringify({
    timestamp: options.timestamp ?? "2026-07-01T15:00:00.000Z",
    type: "turn_context",
    payload: {
      turn_id: "fixture-turn",
      cwd: "/fixture/project",
      model: options.model ?? "gpt-5.4",
      ...(options.effort === null ? {} : { effort: options.effort ?? "high" }),
      user_instructions: SENSITIVE_SENTINEL,
      developer_instructions: SENSITIVE_SENTINEL,
    },
  });
}

export function codexTokenCount(options: {
  last?: Record<string, number> | null;
  total?: Record<string, number>;
  timestamp?: string;
}) {
  return JSON.stringify({
    timestamp: options.timestamp ?? "2026-07-01T15:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: options.last === null ? null : {
        total_token_usage: options.total ?? { input_tokens: 999_999, cached_input_tokens: 999, output_tokens: 999, reasoning_output_tokens: 99, total_tokens: 1_000_998 },
        last_token_usage: options.last ?? { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 60, reasoning_output_tokens: 25, total_tokens: 1060 },
        model_context_window: 258_400,
      },
    },
  });
}

export function codexMessage(text = SENSITIVE_SENTINEL) {
  return JSON.stringify({ timestamp: "2026-07-01T15:00:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
}

export function transcript(lines: string[], { trailingNewline = true } = {}) {
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}
