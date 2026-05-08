import test from "node:test";
import assert from "node:assert/strict";

import { InvalidIdError } from "../milestone-ids.ts";
import {
  _setSqliteRunnerForTests,
  runSqliteCli,
  type SqliteRunner,
} from "../parallel-sqlite-cli.ts";

// Reset the runner before/after every test to keep test order independent.
test.beforeEach(() => {
  _setSqliteRunnerForTests(null);
});
test.afterEach(() => {
  _setSqliteRunnerForTests(null);
});

// ─── Validator boundary ─────────────────────────────────────────────────────

test("runSqliteCli throws InvalidIdError on malicious milestone id", () => {
  // Install a fake runner that would record the call — to prove the wrapper
  // never reaches it for an invalid id.
  let runnerCalls = 0;
  _setSqliteRunnerForTests(() => {
    runnerCalls += 1;
    return { stdout: "should-not-appear", status: 0 };
  });

  let thrown: unknown;
  try {
    runSqliteCli({
      dbPath: "/tmp/fake.db",
      sql: "SELECT 1",
      mid: "M001'; DROP TABLE milestones--",
    });
  } catch (e) {
    thrown = e;
  }

  assert.ok(
    thrown instanceof InvalidIdError,
    "expected InvalidIdError, got: " + String(thrown),
  );
  assert.equal((thrown as InvalidIdError).kind, "milestone");
  assert.equal((thrown as InvalidIdError).source, "runSqliteCli");
  assert.equal(runnerCalls, 0, "runner must not be invoked when validation fails");
});

test("runSqliteCli rejects non-string milestone id without crashing on stringify", () => {
  let thrown: unknown;
  try {
    // Force a non-string through the public surface — the underlying validator
    // must surface a structured InvalidIdError, not a TypeError from RegExp.test.
    runSqliteCli({
      dbPath: "/tmp/fake.db",
      sql: "SELECT 1",
      mid: null as unknown as string,
    });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof InvalidIdError);
  assert.equal((thrown as InvalidIdError).kind, "milestone");
  assert.equal((thrown as InvalidIdError).attemptedId, "null");
});

// ─── Runner seam ────────────────────────────────────────────────────────────

test("_setSqliteRunnerForTests replaces the runner; wrapper passes through args", () => {
  const recorded: Array<{ dbPath: string; sql: string; timeoutMs: number }> = [];
  const fake: SqliteRunner = (args) => {
    recorded.push(args);
    return { stdout: "fake-output\n", status: 0 };
  };
  _setSqliteRunnerForTests(fake);

  const result = runSqliteCli({
    dbPath: "/tmp/db.sqlite",
    sql: "SELECT status FROM milestones WHERE id='M001' LIMIT 1",
    mid: "M001",
  });

  assert.equal(result.stdout, "fake-output\n");
  assert.equal(result.status, 0);
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], {
    dbPath: "/tmp/db.sqlite",
    sql: "SELECT status FROM milestones WHERE id='M001' LIMIT 1",
    timeoutMs: 3000,
  });
});

test("runSqliteCli forwards explicit timeoutMs to the runner", () => {
  let observedTimeout = -1;
  _setSqliteRunnerForTests(({ timeoutMs }) => {
    observedTimeout = timeoutMs;
    return { stdout: "", status: 0 };
  });

  runSqliteCli({
    dbPath: "/tmp/db.sqlite",
    sql: "SELECT 1",
    mid: "M042",
    timeoutMs: 250,
  });

  assert.equal(observedTimeout, 250);
});

test("runSqliteCli accepts unique-suffix milestone ids (M###-xxxxxx)", () => {
  let calls = 0;
  _setSqliteRunnerForTests(() => {
    calls += 1;
    return { stdout: "complete\n", status: 0 };
  });

  runSqliteCli({
    dbPath: "/tmp/db.sqlite",
    sql: "SELECT status FROM milestones WHERE id='M001-abc123' LIMIT 1",
    mid: "M001-abc123",
  });

  assert.equal(calls, 1);
});

test("_setSqliteRunnerForTests(null) resets to default; second fake replaces again", () => {
  // Set a first fake, then reset, then set a second fake — only the second
  // fake should observe the call after reset.
  let firstFakeCalls = 0;
  let secondFakeCalls = 0;

  _setSqliteRunnerForTests(() => {
    firstFakeCalls += 1;
    return { stdout: "first", status: 0 };
  });

  // Reset back to default. We don't want to actually spawn sqlite3 here, so
  // immediately install the second fake — the reset path is exercised by
  // the swap (activeRunner = defaultRunner, then activeRunner = secondFake).
  _setSqliteRunnerForTests(null);
  _setSqliteRunnerForTests(() => {
    secondFakeCalls += 1;
    return { stdout: "second", status: 0 };
  });

  const result = runSqliteCli({
    dbPath: "/tmp/db.sqlite",
    sql: "SELECT 1",
    mid: "M001",
  });

  assert.equal(firstFakeCalls, 0, "first fake must not be reached after reset");
  assert.equal(secondFakeCalls, 1);
  assert.equal(result.stdout, "second");
});

// ─── Result-shape preservation ──────────────────────────────────────────────

test("wrapper preserves status === null shape from the runner (signal-kill semantics)", () => {
  _setSqliteRunnerForTests(() => ({
    stdout: "",
    status: null,
    error: new Error("ETIMEDOUT"),
  }));

  const result = runSqliteCli({
    dbPath: "/tmp/db.sqlite",
    sql: "SELECT 1",
    mid: "M001",
  });

  assert.equal(result.status, null);
  assert.equal(result.stdout, "");
  assert.ok(result.error instanceof Error);
  assert.equal(result.error?.message, "ETIMEDOUT");
});

test("wrapper preserves non-zero status from the runner", () => {
  _setSqliteRunnerForTests(() => ({ stdout: "Error: no such table\n", status: 1 }));

  const result = runSqliteCli({
    dbPath: "/tmp/db.sqlite",
    sql: "SELECT * FROM nope",
    mid: "M001",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "Error: no such table\n");
});
