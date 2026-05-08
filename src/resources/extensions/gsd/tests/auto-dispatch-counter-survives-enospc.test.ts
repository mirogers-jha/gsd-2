/**
 * D004 reproduce-and-prevent for the auto-dispatch counter rewrite (M002/S01/T03).
 *
 * Bug: `setRewriteCount` (auto-dispatch.ts:282) and `incrementUatCount`
 * (auto-dispatch.ts:307) used raw `writeFileSync`. A mid-write ENOSPC (or any
 * non-transient errno) leaves the destination either truncated, partial, or
 * empty — corrupting the rewrite circuit-breaker (#2203) and the per-slice
 * run-uat counter (#3624). Both are JSON files; either silent corruption
 * resets the breaker (data loss) or wedges it (livelock).
 *
 * Fix: route both writes through `atomicWriteSync` (temp + rename). When the
 * rename throws ENOSPC the original file is byte-for-byte unchanged and the
 * `.tmp.*` sibling is cleaned up.
 *
 * This test injects an `AtomicWriteSyncOps` whose `rename` always throws
 * ENOSPC (non-transient → no retry), and asserts:
 *   - the original counter file is byte-for-byte unchanged
 *   - no orphan `.tmp.*` file remains in the runtime dir
 *   - the thrown error preserves `{path, attempts, code}` context
 *
 * Mirrors `createSyncHarness(plan)` from tests/atomic-write.test.ts:51 inline
 * (kept self-contained per the M002/S01/T02 sibling-test convention).
 *
 * To verify D004 manually: revert auto-dispatch.ts to call `writeFileSync`
 * instead of `atomicWriteSync` in either `setRewriteCount` or
 * `incrementUatCount`. The seam is gone, so this test cannot run; an
 * equivalent disk-level reproduction would show the original file replaced by
 * the partial / empty payload.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  setRewriteCountWithOps,
  incrementUatCountWithOps,
  getRewriteCount,
  getUatCount,
} from "../auto-dispatch.ts";
import type { AtomicWriteSyncOps } from "../atomic-write.ts";

const SEED_REWRITE = JSON.stringify({ count: 7, updatedAt: "2026-04-01T00:00:00.000Z" }) + "\n";
const SEED_UAT = JSON.stringify({ count: 2, updatedAt: "2026-04-01T00:00:00.000Z" }) + "\n";

function makeProject(): string {
  // realpath: gsdRoot() canonicalizes via realpathSync before joining
  // .gsd/runtime/. On macOS /var → /private/var; without realpath here, the
  // expected counterPath would not match the path the seam observes.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-m002-s01-t03-enospc-")));
  mkdirSync(join(root, ".gsd", "runtime"), { recursive: true });
  return root;
}

interface EnospcHarness {
  ops: AtomicWriteSyncOps;
  renameCalls: Array<{ from: string; to: string }>;
  unlinkCalls: string[];
  writeFileCalls: Array<{ path: string; content: string }>;
}

/**
 * Inline harness mirroring atomic-write.test.ts:51 createSyncHarness, but
 * pinned to ALWAYS throw ENOSPC on rename — atomic-write.ts treats ENOSPC as
 * non-transient and short-circuits after the first attempt (no retry, no
 * sleep). The injected ops never touch the real fs: the disk seed is
 * preserved purely by the seam, which is what we want to verify.
 */
function createEnospcHarness(): EnospcHarness {
  const renameCalls: Array<{ from: string; to: string }> = [];
  const unlinkCalls: string[] = [];
  const writeFileCalls: Array<{ path: string; content: string }> = [];
  let tempCounter = 0;

  const ops: AtomicWriteSyncOps = {
    mkdir: () => {},
    writeFile: (path, content) => {
      writeFileCalls.push({ path, content: String(content) });
    },
    rename: (from, to) => {
      renameCalls.push({ from, to });
      const err = new Error("no space left on device") as NodeJS.ErrnoException;
      err.code = "ENOSPC";
      throw err;
    },
    unlink: (path) => {
      unlinkCalls.push(path);
    },
    sleep: () => {},
    createTempPath: (filePath) => `${filePath}.tmp.test-${++tempCounter}`,
  };

  return { ops, renameCalls, unlinkCalls, writeFileCalls };
}

test("setRewriteCount — rename ENOSPC leaves seed counter file byte-identical and cleans temp", () => {
  const project = makeProject();
  const counterPath = join(project, ".gsd", "runtime", "rewrite-count.json");
  writeFileSync(counterPath, SEED_REWRITE, "utf-8");

  try {
    const harness = createEnospcHarness();

    let thrown: unknown = null;
    try {
      setRewriteCountWithOps(project, 99, harness.ops);
    } catch (e) {
      thrown = e;
    }

    // 1. Threw, with path + ENOSPC context preserved.
    assert.ok(thrown instanceof Error, "must throw");
    const err = thrown as NodeJS.ErrnoException;
    assert.ok(
      err.message.includes(counterPath),
      `error must name the path; got: ${err.message}`,
    );
    assert.ok(
      /ENOSPC|UNKNOWN/.test(err.message),
      `error must contain ENOSPC code; got: ${err.message}`,
    );
    assert.match(err.message, /attempt/i, "error must mention attempts");
    assert.ok(
      err.code === "ENOSPC" || err.code === "UNKNOWN",
      `error.code must be ENOSPC; got: ${err.code}`,
    );

    // 2. Original file is byte-for-byte the seed.
    const onDisk = readFileSync(counterPath, "utf-8");
    assert.equal(onDisk, SEED_REWRITE, "rewrite-count.json must be untouched on rename failure");

    // 3. getRewriteCount still returns the original value (no in-memory drift).
    assert.equal(getRewriteCount(project), 7, "circuit-breaker counter must read pre-failure value");

    // 4. No orphan .tmp.* in the runtime dir.
    const filesInRuntime = readdirSync(join(project, ".gsd", "runtime"));
    const orphans = filesInRuntime.filter((f) => f.includes(".tmp."));
    assert.deepEqual(orphans, [], `no orphan .tmp.* files; found: ${orphans.join(", ")}`);

    // 5. Seam was actually exercised end-to-end.
    assert.ok(harness.renameCalls.length >= 1, "rename was attempted");
    assert.ok(
      harness.writeFileCalls.length >= 1 &&
        harness.writeFileCalls[0].path.startsWith(counterPath + ".tmp."),
      "writeFile targeted a .tmp.* sibling, not the live counter path",
    );
    assert.ok(
      harness.unlinkCalls.some((p) => p.startsWith(counterPath + ".tmp.")),
      "cleanup unlinked the tmp file after terminal failure",
    );

    // 6. ENOSPC is non-transient → exactly one rename attempt (no retry, no sleep).
    assert.equal(
      harness.renameCalls.length,
      1,
      "ENOSPC is non-transient: must short-circuit after first attempt",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("incrementUatCount — rename ENOSPC leaves seed counter file byte-identical and cleans temp", () => {
  const project = makeProject();
  const mid = "M002";
  const sid = "S01";
  const counterPath = join(project, ".gsd", "runtime", `uat-count-${mid}-${sid}.json`);
  writeFileSync(counterPath, SEED_UAT, "utf-8");

  try {
    const harness = createEnospcHarness();

    let thrown: unknown = null;
    let returned: number | undefined;
    try {
      returned = incrementUatCountWithOps(project, mid, sid, harness.ops);
    } catch (e) {
      thrown = e;
    }

    // 1. Threw — caller must see the failure, not a silent partial increment.
    assert.ok(thrown instanceof Error, "must throw on rename failure");
    assert.equal(returned, undefined, "must not return a count when the write failed");
    const err = thrown as NodeJS.ErrnoException;
    assert.ok(
      err.message.includes(counterPath),
      `error must name the per-slice counter path; got: ${err.message}`,
    );
    assert.ok(
      err.code === "ENOSPC" || err.code === "UNKNOWN",
      `error.code must be ENOSPC; got: ${err.code}`,
    );

    // 2. Original file is byte-for-byte the seed (count stays at 2).
    const onDisk = readFileSync(counterPath, "utf-8");
    assert.equal(onDisk, SEED_UAT, "uat-count file must be untouched on rename failure");
    assert.equal(getUatCount(project, mid, sid), 2, "per-slice counter must read pre-failure value");

    // 3. No orphan tmp files in runtime dir.
    const filesInRuntime = readdirSync(join(project, ".gsd", "runtime"));
    const orphans = filesInRuntime.filter((f) => f.includes(".tmp."));
    assert.deepEqual(orphans, [], `no orphan .tmp.* files; found: ${orphans.join(", ")}`);

    // 4. Seam was exercised: writeFile targeted a tmp sibling, rename was attempted, unlink ran.
    assert.ok(harness.renameCalls.length >= 1, "rename was attempted");
    assert.ok(
      harness.writeFileCalls.length >= 1 &&
        harness.writeFileCalls[0].path.startsWith(counterPath + ".tmp."),
      "writeFile targeted a .tmp.* sibling",
    );
    assert.ok(
      harness.unlinkCalls.some((p) => p.startsWith(counterPath + ".tmp.")),
      "cleanup unlinked the tmp file",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
