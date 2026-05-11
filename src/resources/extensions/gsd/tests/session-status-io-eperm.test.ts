/**
 * session-status-io-eperm.test.ts — D004 reproduce-and-prevent for M003/S02 Bug 1.
 *
 * Bug: `isPidAlive` in `session-status-io.ts:81-88` swallowed every `process.kill`
 * error and returned `false`, so on multi-uid CI hosts a foreign-uid alive PID
 * (`process.kill(pid, 0)` throws `EPERM`) was treated as dead and
 * `cleanupStaleSessions` would unlink the legitimate session's status file.
 *
 * Fix: explicit error-code branching matching the EPERM-aware cousins at
 * `session-lock.ts:668`, `sync-lock.ts:26-33`, `slice-parallel-orchestrator.ts:114-122`:
 *   EPERM   → true  (foreign-uid alive)
 *   ESRCH   → false (truly dead)
 *   ENOENT  → false (no such process)
 *   unknown → true  (fail-safe — never wrongly cleanup)
 *
 * Test strategy: exercise the real `_defaultIsPidAlive` by stubbing `process.kill`
 * to throw each errno; then drive `cleanupStaleSessions` end-to-end through the
 * `_setIsPidAliveForTests` seam to prove the EPERM branch protects an in-tree
 * status file from being wiped.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _defaultIsPidAlive,
  _setIsPidAliveForTests,
  _resetIsPidAliveForTests,
  writeSessionStatus,
  cleanupStaleSessions,
  readAllSessionStatuses,
  type SessionStatus,
} from "../session-status-io.ts";

function makeErrno(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function withStubbedProcessKill(
  throwCode: string | null,
  fn: () => void,
): void {
  const original = process.kill;
  // Replace with a stub that either resolves (alive) or throws the requested errno.
  // The signature must accept the (pid, signal) form used by isPidAlive.
  (process as unknown as { kill: typeof process.kill }).kill = ((
    _pid: number,
    _signal?: string | number,
  ): true => {
    if (throwCode === null) return true;
    throw makeErrno(throwCode);
  }) as typeof process.kill;
  try {
    fn();
  } finally {
    (process as unknown as { kill: typeof process.kill }).kill = original;
  }
}

test("_defaultIsPidAlive returns true on EPERM (foreign-uid alive)", () => {
  withStubbedProcessKill("EPERM", () => {
    assert.equal(_defaultIsPidAlive(99999), true,
      "EPERM means the PID exists but we lack signal permission — must NOT be treated as dead");
  });
});

test("_defaultIsPidAlive returns false on ESRCH (truly dead)", () => {
  withStubbedProcessKill("ESRCH", () => {
    assert.equal(_defaultIsPidAlive(99999), false,
      "ESRCH means no such process — safe to mark stale");
  });
});

test("_defaultIsPidAlive returns false on ENOENT (no such process variant)", () => {
  withStubbedProcessKill("ENOENT", () => {
    assert.equal(_defaultIsPidAlive(99999), false,
      "ENOENT (some platforms) — equivalent to ESRCH");
  });
});

test("_defaultIsPidAlive returns true on unknown errno (fail-safe)", () => {
  withStubbedProcessKill("EINVAL", () => {
    assert.equal(_defaultIsPidAlive(99999), true,
      "Unknown errno must fail-safe to alive — never wrongly cleanup a real session");
  });
});

test("_defaultIsPidAlive returns true when process.kill succeeds", () => {
  withStubbedProcessKill(null, () => {
    assert.equal(_defaultIsPidAlive(99999), true);
  });
});

test("cleanupStaleSessions does NOT remove status when isPidAlive returns true (EPERM-alive scenario)", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-eperm-test-"));
  try {
    const status: SessionStatus = {
      milestoneId: "M999",
      pid: 99999, // an arbitrary PID; the seam decides aliveness
      state: "running",
      currentUnit: null,
      completedUnits: 0,
      cost: 0,
      lastHeartbeat: Date.now(), // fresh — heartbeat alone won't trigger stale
      startedAt: Date.now(),
      worktreePath: base,
    };
    writeSessionStatus(base, status);
    assert.equal(readAllSessionStatuses(base).length, 1, "precondition: status written");

    // Inject EPERM-alive behavior via the seam.
    _setIsPidAliveForTests(() => true);
    try {
      const removed = cleanupStaleSessions(base, 30_000);
      assert.deepEqual(removed, [],
        "Foreign-uid alive PID (EPERM-true) must NOT be cleaned up — this is the bug being prevented");
      assert.equal(readAllSessionStatuses(base).length, 1,
        "status file must still exist on disk");
    } finally {
      _resetIsPidAliveForTests();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanupStaleSessions removes status when isPidAlive returns false (ESRCH-dead scenario)", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-eperm-test-"));
  try {
    const status: SessionStatus = {
      milestoneId: "M998",
      pid: 99998,
      state: "running",
      currentUnit: null,
      completedUnits: 0,
      cost: 0,
      lastHeartbeat: Date.now(),
      startedAt: Date.now(),
      worktreePath: base,
    };
    writeSessionStatus(base, status);
    assert.equal(readAllSessionStatuses(base).length, 1, "precondition: status written");

    _setIsPidAliveForTests(() => false);
    try {
      const removed = cleanupStaleSessions(base, 30_000);
      assert.deepEqual(removed, ["M998"],
        "Truly-dead PID (ESRCH/ENOENT) must be cleaned up — this is the legitimate behavior preserved");
      assert.equal(readAllSessionStatuses(base).length, 0,
        "status file removed from disk");
      // Also no stragglers
      const dirEntries = existsSync(join(base, ".gsd", "parallel"))
        ? readdirSync(join(base, ".gsd", "parallel"))
        : [];
      assert.equal(
        dirEntries.filter((e) => e.endsWith(".status.json")).length,
        0,
        "no .status.json files remain",
      );
    } finally {
      _resetIsPidAliveForTests();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("seam reset restores _defaultIsPidAlive", () => {
  // Stub seam to return false for any PID
  _setIsPidAliveForTests(() => false);
  // Reset
  _resetIsPidAliveForTests();
  // Now the real default takes over — for our own PID it must succeed (no errno thrown)
  assert.equal(_defaultIsPidAlive(process.pid), true);
});
