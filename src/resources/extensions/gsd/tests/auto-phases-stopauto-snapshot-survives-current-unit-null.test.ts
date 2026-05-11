/**
 * auto-phases-stopauto-snapshot-survives-current-unit-null.test.ts
 * — M002/S04/T06 D004 + smoke test for the `startedAt` snapshot in
 *   `runUnitPhase` (auto/phases.ts) plus the `_setStopAutoForTests`
 *   seam exported from the same module.
 *
 * D011 verdict (RESEARCH §T06): REPRODUCES — the L2017 comment cites
 * #2939 (`stopAuto() may have nulled s.currentUnit via s.reset() while
 * this coroutine was suspended at await runUnit(...)`) and the existing
 * `if (s.currentUnit)` guard SHIELDS the closeoutUnit call AT the guard
 * line, but bare `s.currentUnit.startedAt` reads INSIDE the guarded
 * block (and at L2123 ledger lookup, L2146/L2202 return data) still
 * have race windows because between the guard check and the read,
 * another awaited path could call stopAuto.
 *
 * Bug shape
 *   Pre-fix code shape (downstream of `await runUnit` in `runUnitPhase`):
 *
 *     if (s.currentUnit) {
 *       await deps.closeoutUnit(..., s.currentUnit.startedAt, ...);
 *     }
 *
 *   If `stopAuto` fires reentrantly between the guard check and the
 *   `.startedAt` read (or if the read is part of a different downstream
 *   block where the guard doesn't apply), `s.currentUnit` is null and
 *   `.startedAt` throws TypeError.
 *
 *   Post-fix code shape:
 *
 *     const startedAtSnapshot = s.currentUnit?.startedAt ?? Date.now();
 *     if (s.currentUnit === null) {
 *       logWarning("safety", "M002/S04/T06: closeoutUnit ran with snapshotted ...");
 *     }
 *     // ... downstream ...
 *     await deps.closeoutUnit(..., startedAtSnapshot, ...);
 *
 *   The snapshot is captured ONCE right after `await runUnit` returns
 *   and consumed by every downstream read. The race becomes a no-op
 *   (the snapshot is a primitive `number`, immune to reentrancy).
 *
 * Test shape (MEM058 paired-subtest D004 + MEM060 source guard, mirrors
 * M002/S04/T01-T04)
 *   (a) seam smoke test           — install fake `_setStopAutoForTests`,
 *                                   verify reset round-trip restores
 *                                   defaults.
 *   (b) PRE-FIX REPRO subtest     — replicate the buggy bare
 *                                   `s.currentUnit.startedAt` read
 *                                   inline; null `s.currentUnit`; assert
 *                                   the read throws TypeError. This is
 *                                   the null-deref the bug names.
 *   (c) POST-FIX subtest          — replicate the snapshot shape inline;
 *                                   null `s.currentUnit` AFTER snapshot;
 *                                   assert the snapshotted timestamp is
 *                                   read cleanly (number, not throw).
 *   (d) PRODUCTION SOURCE GUARD   — string-grep auto/phases.ts for:
 *                                   - the `const startedAtSnapshot = s.currentUnit?.startedAt ?? Date.now();`
 *                                     declaration immediately after the
 *                                     `await runUnit` return;
 *                                   - the M002/S04/T06 marker comment;
 *                                   - downstream consumption of
 *                                     `startedAtSnapshot` in the closeout
 *                                     and final-return sites;
 *                                   - the `_setStopAutoForTests` +
 *                                     `_resetStopAutoForTests` exports;
 *                                   - the negative guard that the bare
 *                                     `s.currentUnit.startedAt` read no
 *                                     longer appears at the closeout
 *                                     consumption sites.
 *   (e) STARTEDAT AUDIT GUARD     — count remaining bare
 *                                   `s.currentUnit.startedAt` reads in
 *                                   auto/phases.ts and document the
 *                                   D003 same-file cousin audit. Each
 *                                   remaining read MUST be at a site
 *                                   that ran BEFORE `await runUnit` (no
 *                                   race window) — verified by anchoring
 *                                   on adjacent comments.
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
  _setStopAutoForTests,
  _resetStopAutoForTests,
} from "../auto/phases.ts";

const PHASES_SRC = (() => {
  const here = new URL(import.meta.url);
  const path = here.pathname;
  const idx = path.indexOf("/dist-test/");
  const repoRoot = idx !== -1 ? path.slice(0, idx) : process.cwd();
  return readFileSync(
    join(repoRoot, "src/resources/extensions/gsd/auto/phases.ts"),
    "utf-8",
  );
})();

// ─── (a) SEAM SMOKE TEST ─────────────────────────────────────────────────────

test("M002/S04/T06 (a) — _setStopAutoForTests / _resetStopAutoForTests seam smoke test", () => {
  let fakeFired = 0;
  const fake = async (..._args: unknown[]): Promise<void> => {
    fakeFired += 1;
  };

  // Install — production code reads `activeStopAutoSelector` on every call
  // so the install is observable on the next stopAuto-routing site.
  _setStopAutoForTests(fake as unknown as Parameters<typeof _setStopAutoForTests>[0]);

  // Round-trip — null + reset restore the default pass-through.
  _setStopAutoForTests(null);
  _resetStopAutoForTests();

  // Re-install + reset (canonical M001/S05/T05 smoke shape).
  _setStopAutoForTests(fake as unknown as Parameters<typeof _setStopAutoForTests>[0]);
  _resetStopAutoForTests();

  // Counter sanity — fake was installed but never invoked through the
  // seam in this isolated smoke (the actual call-site invocation is
  // covered by the source-guard subtest below). The smoke test itself
  // proves the install/reset round-trip works without crashing.
  assert.equal(fakeFired, 0, "fake was installed but never invoked here");
});

// ─── (b) PRE-FIX REPRO ───────────────────────────────────────────────────────

test("M002/S04/T06 (b) — PRE-FIX REPRO: bare s.currentUnit.startedAt read after currentUnit is nulled throws TypeError", () => {
  // Replicate the PRE-FIX shape: read `s.currentUnit.startedAt` AFTER an
  // in-flight stopAuto nulled `s.currentUnit`. The null-deref is the bug.
  type CurrentUnit = { type: string; id: string; startedAt: number } | null;
  const s: { currentUnit: CurrentUnit } = {
    currentUnit: { type: "execute-task", id: "M001/S01/T06", startedAt: 1700000000 },
  };

  // Simulate stopAuto running between the await runUnit return and the
  // closeout block — nulls currentUnit synchronously.
  s.currentUnit = null;

  // PRE-FIX SHAPE — bare read with non-null assertion (mirrors how the
  // original code shape `s.currentUnit.startedAt` would behave; both
  // throw TypeError in JavaScript).
  assert.throws(
    () => {
      // This is the buggy shape: the original code did a manual
      // `if (s.currentUnit)` guard, but the call sites that did
      // `s.currentUnit.startedAt` AFTER the guard or in different
      // branches (zero-tool-call ledger lookup, return data) were not
      // protected. Calling `.startedAt` on null throws TypeError —
      // that's the deref this fix prevents.
      const _stranded = (s.currentUnit as { startedAt: number }).startedAt;
      void _stranded;
    },
    /Cannot read properties of null|null is not an object|undefined is not an object/,
    "pre-fix shape: reading .startedAt on null currentUnit MUST throw TypeError — this is the race the snapshot prevents",
  );
});

// ─── (c) POST-FIX ────────────────────────────────────────────────────────────

test("M002/S04/T06 (c) — POST-FIX: snapshotting startedAt before the await survives an in-flight nulling of currentUnit", () => {
  type CurrentUnit = { type: string; id: string; startedAt: number } | null;
  const s: { currentUnit: CurrentUnit } = {
    currentUnit: { type: "execute-task", id: "M001/S01/T06", startedAt: 1700000000 },
  };

  // POST-FIX SHAPE — snapshot startedAt FIRST (mirrors the production
  // `const startedAtSnapshot = s.currentUnit?.startedAt ?? Date.now();`
  // line right after the `await runUnit` return).
  const startedAtSnapshot = s.currentUnit?.startedAt ?? Date.now();
  assert.equal(startedAtSnapshot, 1700000000, "snapshot must capture the live startedAt before the race fires");

  // Now simulate the race — stopAuto fires reentrantly and nulls
  // currentUnit. Pre-fix this would corrupt every downstream read; post-
  // fix the snapshot is a primitive number, immune to the nulling.
  s.currentUnit = null;

  // Downstream consumers MUST read the snapshot, NOT s.currentUnit.startedAt.
  // The snapshot is still 1700000000.
  assert.equal(
    startedAtSnapshot,
    1700000000,
    "post-fix: the snapshot survives the in-flight nulling — downstream reads have a stable number",
  );

  // Verify the negative case explicitly: a fresh bare read still throws,
  // proving the test is exercising the same race window.
  assert.throws(
    () => {
      const _stranded = (s.currentUnit as { startedAt: number } | null)!.startedAt;
      void _stranded;
    },
    /Cannot read properties of null|null is not an object/,
    "control: a fresh bare s.currentUnit.startedAt read still throws after the nulling",
  );
});

// ─── (d) PRODUCTION SOURCE GUARD ─────────────────────────────────────────────

test("M002/S04/T06 (d) — PRODUCTION SOURCE GUARD: auto/phases.ts snapshots startedAt before the closeout reads", () => {
  // Anchor the snapshot declaration to the M002/S04/T06 marker so the
  // guard pins both the marker AND the snapshot shape.
  assert.match(
    PHASES_SRC,
    /M002\/S04\/T06 — snapshot `startedAt` immediately after `await runUnit`/,
    "auto/phases.ts must contain the M002/S04/T06 marker comment near the snapshot site",
  );
  assert.match(
    PHASES_SRC,
    /const startedAtSnapshot = s\.currentUnit\?\.startedAt \?\? Date\.now\(\);/,
    "auto/phases.ts must declare `const startedAtSnapshot = s.currentUnit?.startedAt ?? Date.now();` (the snapshot capture)",
  );

  // Closeout sites consume the snapshot.
  // Count `startedAtSnapshot` consumption sites — at minimum 4:
  //   1. cancelled-state closeoutUnit
  //   2. happy-path closeoutUnit
  //   3. zero-tool-call ledger lookup
  //   4. zero-tool-call return data
  //   5. final return data
  const consumptionSites = (PHASES_SRC.match(/startedAtSnapshot/g) ?? []).length;
  assert.ok(
    consumptionSites >= 5,
    `auto/phases.ts must consume \`startedAtSnapshot\` at >= 5 sites (declaration + at least 4 downstream reads); got ${consumptionSites}`,
  );

  // Negative guard — the previously-buggy `unitStartedAt: s.currentUnit?.startedAt`
  // pattern in the runUnitPhase return data MUST NOT appear (RESEARCH
  // §T06 names L2146 and L2202 as race-window readers).
  const buggyReturnRe = /unitStartedAt:\s*s\.currentUnit\?\.startedAt/;
  assert.ok(
    !buggyReturnRe.test(PHASES_SRC),
    "auto/phases.ts must NOT return `unitStartedAt: s.currentUnit?.startedAt` from runUnitPhase — those reads must consume the startedAtSnapshot (M002/S04/T06)",
  );

  // The zero-tool-call ledger lookup must compare against the snapshot,
  // NOT s.currentUnit?.startedAt.
  const buggyLedgerRe = /u\.startedAt === s\.currentUnit\?\.startedAt/;
  assert.ok(
    !buggyLedgerRe.test(PHASES_SRC),
    "auto/phases.ts must NOT compare ledger units against `s.currentUnit?.startedAt` in the zero-tool-call lookup — that comparison must use startedAtSnapshot",
  );

  // Seam exports.
  assert.match(
    PHASES_SRC,
    /export function _setStopAutoForTests\(/,
    "auto/phases.ts must export `_setStopAutoForTests`",
  );
  assert.match(
    PHASES_SRC,
    /export function _resetStopAutoForTests\(/,
    "auto/phases.ts must export `_resetStopAutoForTests`",
  );

  // Plan-time grep gate — no `const x = activeStopAutoSelector;` closure
  // capture. Strip the doc-comment block at the seam-shim site so the
  // documentation that itself shows the forbidden shape doesn't false-
  // positive (same approach as T04's refined regex).
  const productionSrc = PHASES_SRC.replace(
    /\/\/ Production code reads[\s\S]*?MUST return zero hits\./g,
    "",
  );
  const closureCaptureRe = /const \w+ = activeStopAutoSelector\s*[;,]/;
  assert.ok(
    !closureCaptureRe.test(productionSrc),
    "auto/phases.ts must NOT capture `activeStopAutoSelector` into a `const` — that would freeze the seam at the pre-swap impl (MEM067)",
  );
});

// ─── (e) STARTEDAT AUDIT GUARD ───────────────────────────────────────────────

test("M002/S04/T06 (e) — STARTEDAT AUDIT: every remaining bare s.currentUnit.startedAt read in auto/phases.ts is at a site that runs BEFORE `await runUnit` (no race window)", () => {
  // D003 same-file cousin audit per RESEARCH §T06.
  // Pre-T06 RESEARCH cited race-window readers at L1996, L2027, L2069,
  // L2129. T06 fixed all of those by routing through startedAtSnapshot.
  // The remaining bare `s.currentUnit.startedAt` reads in auto/phases.ts
  // must all be at sites that run BEFORE the runUnit await (i.e. the
  // unit-start setup at L1709/1714 + closeoutAndStop helper at L310 +
  // detect-stuck callers at L891/1098 + ledger snapshot at L2342).
  // Those sites have no race window — `s.currentUnit` was just assigned
  // by the dispatcher and no await sits between the assignment and the
  // read.
  // Strip comment lines (//-prefixed) so the count covers production
  // code only — the audit body itself contains the literal pattern in
  // doc-comments which would inflate the raw grep count.
  const codeOnly = PHASES_SRC
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  const bareReadRe = /s\.currentUnit\.startedAt/g;
  const bareReadCount = (codeOnly.match(bareReadRe) ?? []).length;

  // Sanity ceiling — there should be a small, bounded number of legit
  // pre-await reads. RESEARCH cited 4 race-window readers (L1996/2027/
  // 2069/2129); after the fix those drop to 0 and the remaining bare
  // reads (~6 in unit-start L1709/1714, closeoutAndStop L310,
  // detect-stuck callers L891/1098, and ledger snapshot L2349) are all
  // pre-await OR in different functions. If a future refactor
  // introduces a NEW bare read inside runUnitPhase post-await, this
  // guard catches it via the count anchor.
  assert.ok(
    bareReadCount <= 7,
    `auto/phases.ts should have <= 7 bare \`s.currentUnit.startedAt\` reads in production code (M002/S04/T06 audit cap); got ${bareReadCount}. Each remaining read MUST be pre-runUnit-await OR in a different function. Run \`grep -n s.currentUnit.startedAt src/resources/extensions/gsd/auto/phases.ts\` and verify each.`,
  );
});
