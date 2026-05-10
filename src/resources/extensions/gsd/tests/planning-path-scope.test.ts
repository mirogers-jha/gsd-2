// GSD Extension — planning-path-scope validator unit tests.
//
// D004 reproduce-and-prevent: M002/S04 stuck-loop root cause.
//
// Pre-fix behavior: any absolute path NOT under `basePath` was rejected. This
// blocked plans that legitimately reference per-project canonical artifacts
// living under `~/.gsd/projects/<repoHash>/` (the MEM038 external-state
// layout — bug-list, project-scoped notifications, etc.). The plan-slice
// agent for M002/S04 entered an infinite-validation-rejection loop because
// no relative-path representation of `/Users/.../.gsd/projects/<hash>/bug-list.md`
// satisfied the guard.
//
// Post-fix behavior: the validator allows TWO roots — `basePath` and
// `externalGsdRoot(basePath)`. Other absolute paths still reject.
//
// Reproduce gate: tests in this file MUST FAIL against pre-fix
// `planning-path-scope.ts` (single-root validator). Verified by manually
// reverting `planningAllowedRoots` to `return [basePath]` and re-running.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { validatePlanningPathScope, planningAllowedRoots } from '../planning-path-scope.ts';
import { externalGsdRoot } from '../repo-identity.ts';

function makeGitTmpBase(): string {
  // repoIdentity needs a real git root for externalGsdRoot to compute a stable
  // hash. Without `git init`, externalGsdRoot throws and the validator falls
  // back to single-root behavior, which would mask the regression.
  const base = mkdtempSync(join(tmpdir(), 'gsd-path-scope-'));
  execFileSync('git', ['init', '-q', base], { stdio: 'ignore' });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

test('planningAllowedRoots returns basePath plus externalGsdRoot', () => {
  const base = makeGitTmpBase();
  try {
    const roots = planningAllowedRoots(base);
    assert.equal(roots.length, 2, `expected 2 roots, got ${roots.length}: ${roots.join(', ')}`);
    assert.equal(roots[0], base);
    assert.equal(roots[1], externalGsdRoot(base));
    // Sanity: external root must look like .../projects/<12-hex-hash>
    assert.match(roots[1], /[/\\]projects[/\\][0-9a-f]{12}$/);
  } finally {
    cleanup(base);
  }
});

test('validatePlanningPathScope ACCEPTS absolute paths under basePath (pre-existing behavior)', () => {
  const base = makeGitTmpBase();
  try {
    const inside = join(base, 'src', 'foo.ts');
    const result = validatePlanningPathScope(base, [
      { field: 'inputs', values: [inside] },
    ]);
    assert.equal(result, null, `expected null (accepted), got: ${result}`);
  } finally {
    cleanup(base);
  }
});

test('validatePlanningPathScope ACCEPTS absolute paths under externalGsdRoot (D004 fix)', () => {
  const base = makeGitTmpBase();
  try {
    const canonicalBugList = join(externalGsdRoot(base), 'bug-list.md');
    const result = validatePlanningPathScope(base, [
      { field: 'tasks[0].inputs', values: [canonicalBugList] },
    ]);
    assert.equal(
      result,
      null,
      `expected null (accepted) — canonical bug-list under ~/.gsd/projects/<hash>/ ` +
      `must be allowed per MEM038. Got: ${result}`,
    );
  } finally {
    cleanup(base);
  }
});

test('validatePlanningPathScope ACCEPTS nested files under externalGsdRoot', () => {
  const base = makeGitTmpBase();
  try {
    const nested = join(externalGsdRoot(base), 'milestones', 'M002', 'slices', 'S04', 'forward-note.md');
    const result = validatePlanningPathScope(base, [
      { field: 'expectedOutput', values: [nested] },
    ]);
    assert.equal(result, null, `expected null (accepted), got: ${result}`);
  } finally {
    cleanup(base);
  }
});

test('validatePlanningPathScope REJECTS absolute paths outside both roots', () => {
  const base = makeGitTmpBase();
  try {
    const outside = join(tmpdir(), 'totally-elsewhere', 'evil.md');
    const result = validatePlanningPathScope(base, [
      { field: 'tasks[0].inputs', values: [outside] },
    ]);
    assert.ok(result, 'expected non-null error for path outside both roots');
    assert.match(result!, /tasks\[0\]\.inputs contains absolute path outside working directory/);
    // New error hint should mention BOTH allowed roots
    assert.match(result!, /Use a path relative to one of:/);
  } finally {
    cleanup(base);
  }
});

test('validatePlanningPathScope REJECTS sibling-of-external-root paths (no traversal)', () => {
  const base = makeGitTmpBase();
  try {
    // Path that shares a prefix with externalGsdRoot but is a sibling, not nested.
    // Pre-fix `relative()` check could be tricked by string-prefix logic; this
    // test pins down the post-fix path-traversal-safe behavior.
    const external = externalGsdRoot(base);
    const sibling = external + '-sibling-evil';
    const result = validatePlanningPathScope(base, [
      { field: 'inputs', values: [join(sibling, 'whatever.md')] },
    ]);
    assert.ok(result, `expected reject for sibling-of-external path; got null`);
  } finally {
    cleanup(base);
  }
});

test('validatePlanningPathScope passes through when no absolute paths present', () => {
  const base = makeGitTmpBase();
  try {
    const result = validatePlanningPathScope(base, [
      { field: 'inputs', values: ['src/foo.ts', './bar.ts', 'baz.md'] },
      { field: 'expectedOutput', values: [] },
    ]);
    assert.equal(result, null);
  } finally {
    cleanup(base);
  }
});

test('validatePlanningPathScope graceful when externalGsdRoot resolution would fail (no git root)', () => {
  // Edge case: a basePath WITHOUT a `.git` directory. repoIdentity falls back
  // to hashing the path itself, so externalGsdRoot still returns something —
  // but in environments that throw, the validator must not crash.
  const base = mkdtempSync(join(tmpdir(), 'gsd-path-scope-nogit-'));
  try {
    const inside = join(base, 'foo.ts');
    const result = validatePlanningPathScope(base, [
      { field: 'inputs', values: [inside] },
    ]);
    assert.equal(result, null, `non-git basePath must still validate inside-base paths; got: ${result}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('error message lists multiple allowed roots when externalGsdRoot is available', () => {
  const base = makeGitTmpBase();
  try {
    const outside = join(tmpdir(), 'definitely-outside-' + Date.now(), 'nope.md');
    const result = validatePlanningPathScope(base, [
      { field: 'inputs', values: [outside] },
    ]);
    assert.ok(result);
    // Must mention BOTH basePath and externalGsdRoot in the hint so the
    // calling agent knows the canonical bug-list location is allowed.
    assert.ok(result!.includes(base), `error should mention basePath: ${result}`);
    assert.ok(
      result!.includes('projects' + sep) || result!.match(/[/\\]projects[/\\]/),
      `error should mention external projects root: ${result}`,
    );
  } finally {
    cleanup(base);
  }
});
