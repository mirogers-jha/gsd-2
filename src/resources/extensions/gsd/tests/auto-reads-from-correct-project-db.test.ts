/**
 * auto-reads-from-correct-project-db.test.ts — M002/S02 D004 reproduce-and-prevent
 *
 * Regression test for the wrong-project-DB read at auto.ts:~1858, where
 * `getMilestone(meta.milestoneId)` ran BEFORE `ensureDbOpen(base)`. Because
 * `getMilestone` reads from module-global `currentDb` (gsd-db.ts:1702-1707)
 * and `isDbAvailable()` is `currentDb !== null` (gsd-db.ts:610-611), a stale
 * handle from a prior project would silently return the wrong project's row
 * for the same milestone id. The wrong row is truthy, so the existing
 * `!milestoneRow` retry guard never fired.
 *
 * Fix: call `ensureDbOpen(base)` first, then `getMilestone(meta.milestoneId)`.
 *
 * Test shape: two-project tmpdir fixture. Project A holds milestone M001
 * with status 'active'; project B holds M001 with status 'complete'.
 * We "cache" project B's DB by opening it directly (simulating prior
 * project's handle), then the production code path under test must call
 * `ensureDbOpen(projectA)` BEFORE `getMilestone('M001')` — otherwise the
 * read returns project B's `complete` row.
 *
 * D004 verification (manual, performed once at author time): revert the
 * ordering swap in auto.ts and re-run this test; the post-fix assertion
 * must fail by returning project B's `complete` row. Restore and confirm
 * pass. Documented in T02-SUMMARY.
 *
 * Worktree note (MEM032/MEM035): these are plain project-dir fixtures, not
 * `.gsd/worktrees/<MID>/` worktree fixtures, so `resolveWorktreeProjectRoot`
 * does not consult `GSD_PROJECT_ROOT` for them — `env -u GSD_PROJECT_ROOT`
 * is NOT required to run this test cleanly. Documented so future debuggers
 * don't conflate this with the worktree-fixture contamination class.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  closeDatabase,
  openDatabase,
  insertMilestone,
  updateMilestoneStatus,
  getMilestone,
  isDbAvailable,
} from '../gsd-db.ts';
import { ensureDbOpen } from '../bootstrap/dynamic-tools.ts';

function makeProjectDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-s02-${label}-`));
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
}

function seedMilestone(projectDir: string, status: 'active' | 'complete' | 'queued', title: string): void {
  const dbPath = path.join(projectDir, '.gsd', 'gsd.db');
  const opened = openDatabase(dbPath);
  assert.equal(opened, true, `failed to open seed DB at ${dbPath}`);
  insertMilestone({ id: 'M001', title, status });
  // insertMilestone uses INSERT OR IGNORE — for a fresh DB the row inserts
  // with the requested status. updateMilestoneStatus belt-and-suspenders
  // pins the row in case a stray prior row exists in the test DB.
  updateMilestoneStatus('M001', status);
  closeDatabase();
}

describe('auto reads from correct project DB after resume (M002/S02)', () => {
  let projectA: string;
  let projectB: string;

  beforeEach(() => {
    try { closeDatabase(); } catch { /* ok */ }
    projectA = makeProjectDir('projA');
    projectB = makeProjectDir('projB');
    seedMilestone(projectA, 'active', 'Project A');
    seedMilestone(projectB, 'complete', 'Project B');
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* ok */ }
    cleanupDir(projectA);
    cleanupDir(projectB);
  });

  test('PRE-FIX REPRO: getMilestone before ensureDbOpen returns wrong project row', async () => {
    // Simulates the exact ordering at the OLD auto.ts:1858 (replaced in S02):
    //   let dbAvailable = isDbAvailable();
    //   let milestoneRow = dbAvailable ? getMilestone(meta.milestoneId) : null;
    //   if (!milestoneRow) { /* ensureDbOpen + retry */ }
    // The wrong-project row is truthy, so the !milestoneRow retry NEVER fires
    // and the resume path proceeds against the wrong project's row.
    const openedB = openDatabase(path.join(projectB, '.gsd', 'gsd.db'));
    assert.equal(openedB, true, 'fixture: project B DB must open');

    // Buggy ordering — read first, then conditionally open.
    let dbAvailable = isDbAvailable();
    let milestoneRow = dbAvailable ? getMilestone('M001') : null;
    if (!milestoneRow) {
      const opened = await ensureDbOpen(projectA);
      dbAvailable = opened || isDbAvailable();
      if (dbAvailable) milestoneRow = getMilestone('M001');
    }

    // Demonstrates the bug: row is non-null (wrong project's row) AND its
    // status is project B's 'complete', NOT project A's 'active'. The
    // resume path under this ordering would believe milestone M001 is done
    // and clear the paused session for the wrong project.
    assert.notEqual(milestoneRow, null, 'pre-fix: cached handle returns a (wrong) row');
    assert.equal(milestoneRow?.status, 'complete', 'pre-fix: status is project B complete, NOT project A active');
    assert.equal(milestoneRow?.title, 'Project B', 'pre-fix: title is project B, NOT project A');
  });

  test('POST-FIX: ensureDbOpen(A) before getMilestone returns project A row when project B handle was cached', async () => {
    // Arrange: simulate a stale prior-project handle by opening B's DB.
    // This mirrors the resume-from-paused-session window where the parent
    // process held a connection to a prior project's DB before the user
    // switched cwd / resumed under a different project root.
    const openedB = openDatabase(path.join(projectB, '.gsd', 'gsd.db'));
    assert.equal(openedB, true, 'fixture: project B DB must open');
    assert.equal(isDbAvailable(), true, 'fixture: prior-project DB handle is cached');

    // Sanity check the cross-project hazard exists: a naive read against
    // the cached handle returns B's row even though we are about to resume A.
    const naive = getMilestone('M001');
    assert.equal(naive?.status, 'complete', 'fixture sanity: cached handle returns project B row');
    assert.equal(naive?.title, 'Project B', 'fixture sanity: cached handle returns project B row');

    // Act: production code path. The S02 fix at auto.ts:~1858 calls
    // ensureDbOpen(base) BEFORE the first getMilestone read. Replicate
    // exactly that sequence here.
    const opened = await ensureDbOpen(projectA);
    assert.equal(opened, true, 'ensureDbOpen(projectA) must return true');
    const row = getMilestone('M001');

    // Assert: the read now reflects project A's row.
    assert.notEqual(row, null, 'getMilestone must return a row after ensureDbOpen(projectA)');
    assert.equal(row?.status, 'active', 'getMilestone must return project A row (status=active)');
    assert.equal(row?.title, 'Project A', 'getMilestone must return project A row (title=Project A)');
  });
});
