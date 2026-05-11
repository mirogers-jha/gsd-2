/**
 * auto-run-unit-resolver-installed-before-flag-clear.test.ts
 * — M002/S04/T02 D004 paired PRE-FIX/POST-FIX test for the resolver-install
 *   order swap in `src/resources/extensions/gsd/auto/run-unit.ts` at the
 *   per-unit one-shot promise creation site.
 *
 * D011 verdict (RESEARCH §T02): REPRODUCES in current code.
 *
 * Bug shape
 *   Pre-fix order at run-unit.ts (lines 154–157 in the bug-list citation;
 *   actual current line numbers vary as the file evolves):
 *
 *     _setSessionSwitchInFlight(false);   // ← clear flag FIRST (BUG)
 *     const unitPromise = new Promise<UnitResult>((resolve) => {
 *       _setCurrentResolve(resolve);
 *     });
 *
 *   Brief synchronous window between the two statements:
 *     - `_sessionSwitchInFlight === false` (just cleared)
 *     - `_currentResolve === null` (not installed yet)
 *
 *   In `auto/resolve.ts:resolveAgentEnd`, this is the `else` branch: the
 *   event is logged as `no-pending-resolve` and DROPPED. The unit promise
 *   that we are about to create never resolves via this synthetic event.
 *
 *   Post-fix order (this T02 ships):
 *     const unitPromise = new Promise<UnitResult>((resolve) => {
 *       _setCurrentResolve(resolve);
 *     });
 *     _setSessionSwitchInFlight(false);   // ← clear flag AFTER resolver
 *
 *   With the resolver installed first, `resolveAgentEnd` always sees
 *   `_currentResolve !== null` once the flag is cleared, and the event
 *   is delivered.
 *
 * Test shape (MEM058 paired-subtest D004 pattern, mirrors M002/S04/T01)
 *   (a) PRE-FIX REPRO subtest   — replicate the buggy order inline,
 *                                 inject a synthetic agent_end via
 *                                 `resolveAgentEnd` between flag-clear
 *                                 and resolver-install, assert the event
 *                                 is dropped (`_hasPendingResolveForTest`
 *                                 stays true after manual install but
 *                                 the synthetic event was lost — i.e.
 *                                 the "race window" event hit the else
 *                                 branch, not the resolver).
 *   (b) POST-FIX subtest        — replicate the shipped order inline,
 *                                 inject the same synthetic agent_end
 *                                 in the equivalent window, assert the
 *                                 unitPromise resolves with the synthetic
 *                                 event.
 *   (c) PRODUCTION SOURCE GUARD — string-grep run-unit.ts for the
 *                                 post-fix order. If a future refactor
 *                                 re-introduces the bug, this guard
 *                                 fails immediately. Same MEM060 D011
 *                                 reproduce-and-prevent pattern as T01.
 *
 *   Subtest (a)'s "synthetic injection in the window" is the deterministic
 *   interleaving the seam exists to enable. We don't need the real
 *   `_setAgentEndDispatcherForTests` seam from T01 here — the relevant
 *   resolver state lives in `auto/resolve.ts` and is directly observable
 *   via `_hasPendingResolveForTest`/`peekLogs`. Calling `resolveAgentEnd`
 *   between the two synchronous statements is the moral equivalent of
 *   what an agent_end event would do at that moment.
 *
 * R015 compliance: no new dependencies. node:test + node:fs only.
 *
 * MEM046 baseline: prefix CI runs with
 *   `env -u GSD_PROJECT_ROOT PATH="$PWD/node_modules/.bin:$PATH"`
 * to avoid worktree-resolver contamination.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  _setCurrentResolve,
  _clearCurrentResolve,
  _setSessionSwitchInFlight,
  isSessionSwitchInFlight,
  _hasPendingResolveForTest,
  _resetPendingResolve,
  resolveAgentEnd,
} from "../auto/resolve.ts";
import type { UnitResult, AgentEndEvent } from "../auto/types.ts";
import { _resetLogs } from "../workflow-logger.ts";
import { debugLog } from "../debug-logger.ts";

const RUN_UNIT_SRC = (() => {
  // dist-test/src/resources/extensions/gsd/tests/<this>.test.js → walk up
  // to the repoRoot so we can read the production source verbatim.
  const here = new URL(import.meta.url);
  const path = here.pathname;
  const idx = path.indexOf("/dist-test/");
  const repoRoot = idx !== -1 ? path.slice(0, idx) : process.cwd();
  return readFileSync(
    join(repoRoot, "src/resources/extensions/gsd/auto/run-unit.ts"),
    "utf-8",
  );
})();

function makeSyntheticAgentEnd(tag: string): AgentEndEvent {
  // Cast through unknown — the AgentEndEvent type lives in pi-coding-agent
  // and is shaped { messages: Message[]; … }. For these tests we only care
  // that the resolver receives an object with our `_synthetic: tag` marker
  // so we can verify which event was delivered.
  return { messages: [], _synthetic: tag } as unknown as AgentEndEvent;
}

// ─── (a) PRE-FIX REPRO ───────────────────────────────────────────────────────

test("M002/S04/T02 (a) — PRE-FIX REPRO: clearing the session-switch flag BEFORE installing the resolver drops a synthetic agent_end that arrives in the window", async () => {
  _resetPendingResolve();
  _resetLogs();
  // Precondition: the test simulates the moment AFTER session-switch has
  // begun (flag is true) and BEFORE the unit promise is created.
  _setSessionSwitchInFlight(true);
  assert.equal(isSessionSwitchInFlight(), true, "precondition: flag is true");
  assert.equal(
    _hasPendingResolveForTest(),
    false,
    "precondition: no resolver installed yet",
  );

  // ── Replicate the PRE-FIX shape inline. ──
  // _setSessionSwitchInFlight(false);           ← clear flag FIRST
  // ░░░ window opens here ░░░
  // const unitPromise = new Promise(resolve => { _setCurrentResolve(resolve); });
  //
  // Inside the window we synthesize an agent_end arrival via
  // `resolveAgentEnd`. With the flag cleared and no resolver, the event
  // hits the else branch and is dropped.

  const synthetic = makeSyntheticAgentEnd("pre-fix-window-event");
  let unitResolved = false;
  let unitResolution: UnitResult | null = null;

  // Step 1: clear the flag (the BUG).
  _setSessionSwitchInFlight(false);

  // Step 2: BEFORE installing the resolver, an agent_end event arrives.
  // This is the synthetic interleaving — in production, the agent_end
  // handler would call `resolveAgentEnd` from the model's event stream
  // any time after newSession returns. Here we drive it explicitly.
  resolveAgentEnd(synthetic);

  // Step 3: install the resolver (the second statement of the buggy pair).
  const unitPromise = new Promise<UnitResult>((resolve) => {
    _setCurrentResolve(resolve);
  });
  unitPromise.then((r) => {
    unitResolved = true;
    unitResolution = r;
  });

  // Allow microtasks to flush — if the synthetic event had landed on the
  // resolver, the promise would settle in the next microtask.
  await Promise.resolve();
  await Promise.resolve();

  // PRE-FIX BUG: the synthetic event hit the else branch in
  // `resolveAgentEnd` (no _currentResolve at the moment of the call) and
  // was dropped. The resolver we installed AFTER is still pending.
  assert.equal(
    unitResolved,
    false,
    "pre-fix shape: the synthetic agent_end was dropped because it arrived in the window between flag-clear and resolver-install — unitPromise stays unresolved",
  );
  assert.equal(
    unitResolution,
    null,
    "pre-fix shape: unitPromise must not have received the synthetic event",
  );
  assert.equal(
    _hasPendingResolveForTest(),
    true,
    "pre-fix shape: the late-installed resolver is still sitting waiting for an event that never came",
  );

  // Cleanup — manually resolve so the dangling promise doesn't leak.
  resolveAgentEnd(makeSyntheticAgentEnd("cleanup"));
  await Promise.resolve();
  _resetPendingResolve();
  _resetLogs();
});

// ─── (b) POST-FIX ────────────────────────────────────────────────────────────

test("M002/S04/T02 (b) — POST-FIX: installing the resolver BEFORE clearing the session-switch flag delivers a synthetic agent_end that arrives in the equivalent window", async () => {
  _resetPendingResolve();
  _resetLogs();
  _setSessionSwitchInFlight(true);
  assert.equal(isSessionSwitchInFlight(), true, "precondition: flag is true");
  assert.equal(
    _hasPendingResolveForTest(),
    false,
    "precondition: no resolver installed yet",
  );

  // ── Replicate the POST-FIX shape inline. ──
  // const unitPromise = new Promise(resolve => { _setCurrentResolve(resolve); });
  // ░░░ window opens here, but resolver is already installed ░░░
  //   → resolveAgentEnd would see _sessionSwitchInFlight === true here
  //     and ignore the event (correct: ignored-during-switch). The window
  //     where a real agent_end could land BETWEEN the two statements is
  //     the moment AFTER the next line clears the flag.
  // _setSessionSwitchInFlight(false);
  //
  // Equivalent injection: install resolver, then call resolveAgentEnd
  // BETWEEN install-and-clear (event is ignored-during-switch — also
  // a drop, but for the right reason; not the bug) AND between
  // clear-and-anything-else (event delivers — this is what we test).

  const synthetic = makeSyntheticAgentEnd("post-fix-window-event");
  let unitResolved = false;
  let unitResolution: UnitResult | null = null;

  // Step 1: install the resolver (the FIX).
  const unitPromise = new Promise<UnitResult>((resolve) => {
    _setCurrentResolve(resolve);
  });
  unitPromise.then((r) => {
    unitResolved = true;
    unitResolution = r;
  });

  // Step 2: clear the flag.
  _setSessionSwitchInFlight(false);

  // Step 3: an agent_end event arrives. With the resolver already in
  // place AND the flag cleared, `resolveAgentEnd` takes the resolving
  // branch and delivers the event.
  resolveAgentEnd(synthetic);

  // Allow microtasks to flush so the .then callback runs.
  await Promise.resolve();
  await Promise.resolve();

  // POST-FIX: the synthetic event was delivered to the resolver.
  assert.equal(
    unitResolved,
    true,
    "post-fix shape: the synthetic agent_end resolves the unit promise — the window-arriving event is no longer dropped",
  );
  assert.ok(unitResolution, "unitResolution must be populated");
  assert.equal(
    (unitResolution as UnitResult & { event?: AgentEndEvent }).status,
    "completed",
    "post-fix unit promise resolves with status: completed",
  );
  // Verify the synthetic marker round-tripped, proving it was OUR event
  // that resolved the promise — not some leaked prior event.
  const event = (unitResolution as UnitResult & { event?: AgentEndEvent }).event as
    | (AgentEndEvent & { _synthetic?: string })
    | undefined;
  assert.equal(
    event?._synthetic,
    "post-fix-window-event",
    "the resolved event must be the synthetic one we injected",
  );
  assert.equal(
    _hasPendingResolveForTest(),
    false,
    "post-fix shape: the resolver is consumed (one-shot) after delivery",
  );

  // Cleanup.
  _resetPendingResolve();
  _resetLogs();
});

// ─── (c) PRODUCTION SOURCE GUARD ─────────────────────────────────────────────

test("M002/S04/T02 (c) — PRODUCTION SOURCE GUARD: run-unit.ts installs the resolver BEFORE clearing the session-switch flag", () => {
  // Post-fix order shape: `new Promise(...resolve... _setCurrentResolve(resolve)...)`
  // followed by `_setSessionSwitchInFlight(false);` with NO `_setSessionSwitchInFlight(false);`
  // appearing between them.
  //
  // We anchor the regex on the unitPromise creation site (the `new Promise<UnitResult>`
  // pattern is unique) so the guard pins the per-unit one-shot promise specifically.

  // Find the unitPromise creation block — must contain `_setCurrentResolve(resolve)`
  // followed (within the same arrow body / a few lines after the close) by
  // `_setSessionSwitchInFlight(false);`. The pre-fix shape has the flag-clear
  // BEFORE `new Promise` — the post-fix shape has it AFTER.
  assert.match(
    RUN_UNIT_SRC,
    /const unitPromise = new Promise<UnitResult>\(\s*\(resolve\)\s*=>\s*\{\s*_setCurrentResolve\(resolve\);\s*\}\s*\);\s*\n\s*_setSessionSwitchInFlight\(false\);/,
    "run-unit.ts must install the unitPromise resolver BEFORE the per-unit `_setSessionSwitchInFlight(false);` call (M002/S04/T02 fix)",
  );

  // Negative guard — the buggy order MUST NOT appear: a
  // `_setSessionSwitchInFlight(false);` line followed immediately (within a
  // few intervening lines of comments) by the `new Promise<UnitResult>` +
  // `_setCurrentResolve(resolve)` block. Match a tight window so that the
  // outer T01 envelope's `_setSessionSwitchInFlight(false);` (which lives
  // inside the chained `.finally(() => { ... })` on sessionPromise, ~80
  // lines above) does not produce a false positive.
  const buggyOrderRe =
    /_setSessionSwitchInFlight\(false\);\s*\n(?:\s*\n|\s*\/\/[^\n]*\n){0,4}\s*const unitPromise = new Promise<UnitResult>\(\s*\(resolve\)\s*=>\s*\{\s*_setCurrentResolve\(resolve\);/;
  assert.ok(
    !buggyOrderRe.test(RUN_UNIT_SRC),
    "run-unit.ts must NOT contain the pre-fix order `_setSessionSwitchInFlight(false); ... new Promise<UnitResult>((resolve) => { _setCurrentResolve(resolve); ` — that is the M002/S04/T02 race-window bug (RESEARCH §T02)",
  );
});

// ─── Test-only sanity: silence the debugLog import so unused-import lint
// rules in dist-test do not flag. ───
debugLog;
_clearCurrentResolve;
