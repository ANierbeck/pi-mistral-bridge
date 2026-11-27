# Report rate limits through Pi's `onResponse` stream option

**Status:** approved — 2026-11-27 (owner chose "429 without retry-after").

## Problem

The dynamic model router will read a rate limit from the response of each
physical attempt (`options.onResponse`, pi-ai `SimpleStreamOptions`) instead
of parsing error text. Today the bridge only ends the stream with an error
whose text starts with `Mistral Vibe quota exceeded` (ADR-0002); it never
calls `onResponse`.

The requested payload carries a `retry-after` reset time. **Vibe does not
provide one.** On a rate limit `vibe-acp` returns the ACP error code `-31001`
with the message `Rate limit exceeded for <provider> (model: <model>).` and
`data: { provider, model }` only. Vibe honours a server `Retry-After` itself
(`vibe/core/utils/retry.py`) and does not forward it; no quota or usage
endpoint exists in the installed Vibe. A `retry-after` header would therefore
be an invented value.

The bridge also classifies quota errors only by a text regex (`QUOTA_RE`,
`src/acp-client.ts`), although the error code is stable and more reliable.

## Solution

1. **Classify by code.** `src/vibe-protocol.ts` (the one module for Vibe
   specifics, AGENTS.md §16) gains `VIBE_RATE_LIMIT_ERROR_CODE = -31001`.
   `classifyAcpError` maps an error with that `code` to kind `quota` (same
   `Mistral Vibe quota exceeded: …` message). The text regex stays as the
   fallback for other wording and older Vibe versions.
2. **Report the limit.** When a turn ends with an `AcpClientError` of kind
   `quota`, `streamSimple` calls `options.onResponse` exactly once, before the
   terminal `error` event, with
   `{ status: 429, headers: {} }` and the served `model`. No `retry-after`:
   the router then uses its own backoff. The bridge never sends a reset time
   it does not know, and never forwards other headers.
   - Only when `options.onResponse` is a function.
   - Wrapped in try/catch (sync throw and rejected promise): a failing
     callback never changes the stream's outcome.
   - Every path that ends a turn with a quota error is covered (the settled
     prompt failure in `finishTurn`, and the last-resort `endWithError`),
     through one helper so the call happens once per failed attempt.
3. The error text is unchanged, so the router's text detection keeps working
   until its header path ships.

AskVibe agent mode is not a stream and is not touched.

## Open decisions

None. A configurable cooldown (`rateLimitRetryAfterSeconds`) was considered and
declined by the owner; if Vibe later exposes a reset time over ACP, sending
`retry-after` is a follow-up with its own plan.

## Verified against

- `vibe-acp` 3.1.4 source: `vibe/acp/exceptions.py` (`RATE_LIMITED = -31001`,
  `RateLimitError`), `vibe/core/utils/retry.py` (`_parse_retry_after`).
  The installed `vibe` tree has no quota/usage/reset surface (grep for
  quota/allowance found nothing).
- pi 1.6.1, `@earendil-works/pi-ai` `types.d.ts`: `ProviderResponse`,
  `onResponse?: (response, model) => void | Promise<void>`.
- Router plan `2026-11-27-provider-response-rate-limit.md` (router fork,
  commit `617d39f`): without a reset time the router falls back to its backoff.
- **Not verified:** that the router's call path delivers `options.onResponse`
  to the bridge (that is step 1 of the router plan, a spike on its side); no
  real rate limit was triggered against Vibe (would consume allowance).

## Tasks

- [ ] T1 Red-first tests, then `VIBE_RATE_LIMIT_ERROR_CODE` + code-based
  classification (fake ACP agent returns a JSON-RPC error with code `-31001`
  and wording that the regex does not match).
- [ ] T2 Red-first tests, then the single `onResponse` helper wired into every
  quota-ending path (spy called once with status 429, empty headers, the
  served model; throwing and rejecting spies do not change the outcome; no
  call for non-quota errors, success, abort; no call without a function).
- [ ] T3 README (rate-limit behaviour, Vibe gives no reset time), CHANGELOG
  `Unreleased`.
