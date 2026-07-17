/**
 * City-context injection de-duplication.
 *
 * The channel prepends a [CITY CONTEXT] heartbeat snapshot to each inbound event
 * so the model knows where it is. That snapshot is cached (~5 min), so within a
 * burst of events every prepend is byte-for-byte identical — re-injecting it adds
 * no information, only token bloat and a wall of repeated context in the agent's
 * history (the Aaga model-login loop, 2026-06-30, prepended it ~7x in a minute).
 *
 * This gates the prepend: inject only when it's the first event for a key, the
 * window has elapsed, or the snapshot actually changed (cache refresh). Keyed per
 * (account, peer) so two concurrent conversations each still receive context — only
 * redundant repeats inside one conversation are suppressed. No information is lost:
 * the suppressed copies are identical to the one already in the session history.
 */
export interface ContextInjectionRecord {
  at: number;
  ctx: string;
}

/**
 * Decide whether to prepend the city-context snapshot for `key`, and record the
 * decision in `state`. Returns true to inject (and updates the record), false to
 * skip a recent identical repeat. Pure given (state, key, ctx, now, windowMs).
 */
export function shouldInjectCityContext(
  state: Map<string, ContextInjectionRecord>,
  key: string,
  ctx: string,
  now: number,
  windowMs: number,
): boolean {
  const prev = state.get(key);
  const inject = !prev || now - prev.at >= windowMs || prev.ctx !== ctx;
  if (inject) {
    state.set(key, { at: now, ctx });
  }
  return inject;
}
