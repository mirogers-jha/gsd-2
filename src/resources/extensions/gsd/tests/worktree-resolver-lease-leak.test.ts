// Project/App: GSD-2
// File Purpose: D004 reproduce-and-prevent test for M003/S04 Bug 1 — the
// worktree-resolver `enterMilestone` catch arm leaked the milestone lease
// when `createAutoWorktree` threw, holding it until TTL (~5 min) and
// blocking other workers from entering the same milestone.
//
// MEM035: every test deletes process.env.GSD_PROJECT_ROOT in beforeEach so
// resolveWorktreeProjectRoot() does NOT short-circuit our tmpdir fixture
// paths back to the live repo.
// MEM079: realpathSync(mkdtempSync(...)) so symlinked /tmp on macOS does not
// confuse worktree-path comparisons.
// MEM013: caller (auto-mode harness) creates the worktree-root node_modules
// symlink; this test does not import production node-only deps that need it.

import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorktreeResolver,
  _resetReleaseMilestoneLeaseForTests,
  _setReleaseMilestoneLeaseForTests,
  type NotifyCtx,
  type WorktreeResolverDeps,
} from "../worktree-resolver.js";
import { AutoSession } from "../auto/session.js";
import {
  closeDatabase,
  insertMilestone,
  openDatabase,
} from "../gsd-db.js";
import { registerAutoWorker } from "../db/auto-workers.js";
import {
  claimMilestoneLease,
  getMilestoneLease,
} from "../db/milestone-leases.js";

// ─── Test scaffolding ───────────────────────────────────────────────────────

function makeDbBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-wt-lease-leak-")));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanupDbBase(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

interface NotifyCtxWithLog extends NotifyCtx {
  messages: Array<{ msg: string; level?: string }>;
}
function makeNotifyCtx(): NotifyCtxWithLog {
  const messages: Array<{ msg: string; level?: string }> = [];
  return {
    messages,
    notify: (msg: string, level?: "info" | "warning" | "error" | "success") => {
      messages.push({ msg, level });
    },
  };
}

/** Build a WorktreeResolverDeps with `createAutoWorktree` configured to throw
 *  the supplied error message. All other deps return safe defaults — none of
 *  them should be reached when create throws first. */
function makeDepsCreateThrows(errorMsg: string): WorktreeResolverDeps {
  return {
    isInAutoWorktree: () => false,
    shouldUseWorktreeIsolation: () => true,
    getIsolationMode: () => "worktree",
    mergeMilestoneToMain: () => ({ pushed: false, codeFilesChanged: false }),
    syncWorktreeStateBack: () => ({ synced: [] }),
    teardownAutoWorktree: () => {},
    createAutoWorktree: () => {
      throw new Error(errorMsg);
    },
    enterAutoWorktree: () => {
      throw new Error("unexpected enterAutoWorktree in lease-leak test");
    },
    enterBranchModeForMilestone: () => {},
    getAutoWorktreePath: () => null,
    autoCommitCurrentBranch: () => {},
    getCurrentBranch: () => "main",
    autoWorktreeBranch: (mid) => `auto/milestone/${mid}`,
    resolveMilestoneFile: () => null,
    readFileSync: () => "",
    GitServiceImpl: class {
      constructor(_basePath: string, _gitConfig: unknown) {}
    } as unknown as WorktreeResolverDeps["GitServiceImpl"],
    loadEffectiveGSDPreferences: () => undefined,
    invalidateAllCaches: () => {},
    captureIntegrationBranch: () => {},
  };
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

let savedProjectRoot: string | undefined;
beforeEach(() => {
  // MEM035: prevent inherited GSD_PROJECT_ROOT from contaminating tmp paths.
  savedProjectRoot = process.env.GSD_PROJECT_ROOT;
  delete process.env.GSD_PROJECT_ROOT;
});
afterEach(() => {
  _resetReleaseMilestoneLeaseForTests();
  if (savedProjectRoot !== undefined) {
    process.env.GSD_PROJECT_ROOT = savedProjectRoot;
  }
});

// ─── Sub-test A — happy lease-release path ──────────────────────────────────

test("Bug1.A enterMilestone catch releases milestone lease + clears state when createAutoWorktree throws", () => {
  const base = makeDbBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M_FOO", title: "Test", status: "active" });

    const w1 = registerAutoWorker({ projectRootRealpath: base });
    const w2 = registerAutoWorker({ projectRootRealpath: base });

    const s = new AutoSession();
    s.basePath = base;
    s.originalBasePath = base;
    s.workerId = w1;

    const deps = makeDepsCreateThrows("simulated worktree create failure");
    const ctx = makeNotifyCtx();
    const resolver = new WorktreeResolver(s, deps);

    // First enterMilestone: claims lease then createAutoWorktree throws.
    // Pre-fix: lease leaks. Post-fix: catch releases it.
    resolver.enterMilestone("M_FOO", ctx);

    // catch path ran: warning notified, isolation degraded.
    assert.ok(
      ctx.messages.some(
        (m) => m.level === "warning" && m.msg.includes("simulated worktree create failure"),
      ),
      "expected warning notify with the original error",
    );
    assert.equal(s.isolationDegraded, true, "isolationDegraded must be set in catch path");

    // POST-FIX assertion: session state cleared.
    assert.equal(s.milestoneLeaseToken, null, "milestoneLeaseToken must be cleared after catch released the lease");
    assert.equal(s.currentMilestoneId, null, "currentMilestoneId must be cleared after catch released the lease");

    // POST-FIX assertion: DB-level lease is no longer held by w1 — meaning a
    // different worker w2 can claim it immediately rather than waiting TTL.
    const claim = claimMilestoneLease(w2, "M_FOO");
    assert.equal(claim.ok, true, "second worker must be able to claim M_FOO after w1 released — proves no leak");
    if (!claim.ok) throw new Error("expected w2 claim to succeed");

    const row = getMilestoneLease("M_FOO");
    assert.ok(row, "lease row should exist after w2 claim");
    assert.equal(row.worker_id, w2, "lease should now be held by w2, not w1");
    assert.equal(row.status, "held");
  } finally {
    cleanupDbBase(base);
  }
});

// ─── Sub-test B — release-throw is swallowed ────────────────────────────────

test("Bug1.B enterMilestone catch swallows lease-release errors and still clears local state", () => {
  const base = makeDbBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M_BAR", title: "Test", status: "active" });

    const w1 = registerAutoWorker({ projectRootRealpath: base });

    const s = new AutoSession();
    s.basePath = base;
    s.originalBasePath = base;
    s.workerId = w1;

    // Install a fake releaseMilestoneLease that throws — exercises the
    // try/catch around the seam.
    let releaseSeamCalls = 0;
    _setReleaseMilestoneLeaseForTests(() => {
      releaseSeamCalls++;
      throw new Error("simulated lease-release failure");
    });

    const deps = makeDepsCreateThrows("disk full");
    const ctx = makeNotifyCtx();
    const resolver = new WorktreeResolver(s, deps);

    // Must NOT throw the release error — the original create error is the
    // only thing the caller / notify stream cares about.
    assert.doesNotThrow(
      () => resolver.enterMilestone("M_BAR", ctx),
      "enterMilestone must swallow lease-release errors and only surface the original create failure",
    );

    // Original create-failure warning still surfaces.
    assert.ok(
      ctx.messages.some(
        (m) => m.level === "warning" && m.msg.includes("disk full"),
      ),
      "original createAutoWorktree warning must still reach notify",
    );

    // Seam was actually invoked — proves the catch attempted release.
    assert.equal(releaseSeamCalls, 1, "release seam must be called exactly once");

    // State is cleared even when release threw.
    assert.equal(s.milestoneLeaseToken, null, "milestoneLeaseToken must be cleared even if release throws");
    assert.equal(s.currentMilestoneId, null, "currentMilestoneId must be cleared even if release throws");
    assert.equal(s.isolationDegraded, true, "isolationDegraded must still be set");
  } finally {
    cleanupDbBase(base);
  }
});
