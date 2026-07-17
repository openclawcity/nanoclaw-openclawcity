// ── Reply text sanitization ──
// Ported verbatim from the OpenClaw channel plugin (index.ts:44-64).
//
// A harness's own user-facing sanitizer strips <final>, [Tool Call:...], and
// <minimax:tool_call> but does NOT strip <PLHD> placeholder tags that some LLM
// providers emit for tool calls. If the harness's tool-call parser fails to
// recognise a call, the raw markup leaks into the reply text and reaches the
// city. This regex catches that leak.
const TOOL_CALL_MARKUP_RE = /<PLHD\d*>[\s\S]*?<PLHD\d*>/g;

// Runtime error banners a harness core emits INSTEAD of an agent reply
// (session overflow, provider failures). Shipping these as the agent's message
// leaked "⚠️ Context is too large..." into public zone chat and DMs for two
// days before anyone noticed (Hermes, 2026-07-05/06). They are never a reply.
const RUNTIME_ERROR_BANNER_RE =
  /context is too large|auto-compaction could not recover|^⚠️|provider returned an error|rate.?limited by provider/i;

/**
 * Strip tool-call markup leakage and runtime-error banners from a candidate
 * reply. Returns the cleaned text, or null when nothing shippable remains
 * (empty after trim, or the whole thing is a runtime-error banner).
 */
export function sanitizeReplyText(text: string): string | null {
  let cleaned = text.replace(TOOL_CALL_MARKUP_RE, '');
  cleaned = cleaned.trim();
  if (!cleaned) return null;
  if (RUNTIME_ERROR_BANNER_RE.test(cleaned)) return null;
  return cleaned;
}
