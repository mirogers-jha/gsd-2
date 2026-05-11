// Regression test for assertSafeStateWrite (LiveStateWriteViolation).
//
// Closes the leak class documented in MEM-Tests where test fixtures write
// to the live project's .gsd/ state via cached DB connections, fixture
// basePath strings ("/project"), or GSD_PROJECT_ROOT contamination.
//
// The guard refuses writes to:
//   - paths under GSD_PROJECT_ROOT (the live project root)
//   - paths under ~/.gsd/projects/<hash>/ (live external state)
// when running in a test context (NODE_TEST_CONTEXT, VITEST, etc.).
//
// Bypass via GSD_INTERNAL_ALLOW_LIVE_WRITE=1 for tests that intentionally
// exercise live workspaces.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { assertSafeStateWrite, LiveStateWriteViolation } from "../paths.ts";

function withEnv<T>(mutations: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(mutations)) {
    previous.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("assertSafeStateWrite: passes for paths outside live project", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "gsd-safe-state-pass-")));
  try {
    withEnv(
      { GSD_PROJECT_ROOT: "/some/other/project", GSD_INTERNAL_ALLOW_LIVE_WRITE: undefined },
      () => {
        // Tmp paths far from live project must not throw.
        assertSafeStateWrite(join(tmp, "OVERRIDES.md"), "test-op");
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("assertSafeStateWrite: throws LiveStateWriteViolation when target is under GSD_PROJECT_ROOT", () => {
  const liveRoot = realpathSync(mkdtempSync(join(tmpdir(), "gsd-safe-state-live-")));
  try {
    withEnv(
      { GSD_PROJECT_ROOT: liveRoot, GSD_INTERNAL_ALLOW_LIVE_WRITE: undefined },
      () => {
        let caught: unknown;
        try {
          assertSafeStateWrite(join(liveRoot, ".gsd", "OVERRIDES.md"), "appendOverride");
        } catch (err) {
          caught = err;
        }
        assert.ok(caught, "guard must throw on live-project write");
        assert.ok(caught instanceof LiveStateWriteViolation, "must be LiveStateWriteViolation");
        const e = caught as LiveStateWriteViolation;
        assert.equal(e.operation, "appendOverride");
        assert.match(e.message, /refusing to write to live project state/);
        assert.match(e.message, /Set GSD_INTERNAL_ALLOW_LIVE_WRITE=1 to bypass/);
      },
    );
  } finally {
    rmSync(liveRoot, { recursive: true, force: true });
  }
});

test("assertSafeStateWrite: throws when target is under ~/.gsd/projects/", () => {
  // Construct a fake target under the user's gsd home — this is the path
  // shape that exposed the actual data-loss bug (PI process writes via
  // cached connection to live external state).
  const fakeHash = "deadbeef1234";
  const target = join(homedir(), ".gsd", "projects", fakeHash, "OVERRIDES.md");
  withEnv(
    { GSD_PROJECT_ROOT: undefined, GSD_INTERNAL_ALLOW_LIVE_WRITE: undefined },
    () => {
      let caught: unknown;
      try {
        assertSafeStateWrite(target, "emitUokAuditEvent");
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof LiveStateWriteViolation, "must throw LiveStateWriteViolation");
      assert.equal((caught as LiveStateWriteViolation).operation, "emitUokAuditEvent");
    },
  );
});

test("assertSafeStateWrite: bypassed by GSD_INTERNAL_ALLOW_LIVE_WRITE=1", () => {
  const liveRoot = realpathSync(mkdtempSync(join(tmpdir(), "gsd-safe-state-bypass-")));
  try {
    withEnv(
      { GSD_PROJECT_ROOT: liveRoot, GSD_INTERNAL_ALLOW_LIVE_WRITE: "1" },
      () => {
        // Should NOT throw despite target being under live project.
        assertSafeStateWrite(join(liveRoot, ".gsd", "OVERRIDES.md"), "test-op");
      },
    );
  } finally {
    rmSync(liveRoot, { recursive: true, force: true });
  }
});

test("assertSafeStateWrite: only fires under test context", () => {
  // Not really a runtime path because we ARE in a test context — but verify
  // the bypass-by-env path is the only documented escape, since detecting
  // "not test context" requires unsetting NODE_TEST_CONTEXT which would
  // then disable the test's own assertion machinery. So we use the env
  // bypass as a stand-in.
  const liveRoot = realpathSync(mkdtempSync(join(tmpdir(), "gsd-safe-state-ctx-")));
  try {
    // Bypass active — should pass even though guard would otherwise fire.
    withEnv(
      { GSD_PROJECT_ROOT: liveRoot, GSD_INTERNAL_ALLOW_LIVE_WRITE: "true" },
      () => {
        assertSafeStateWrite(join(liveRoot, ".gsd", "STATE.md"), "test-op");
      },
    );
  } finally {
    rmSync(liveRoot, { recursive: true, force: true });
  }
});
