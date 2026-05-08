import test from "node:test";
import assert from "node:assert/strict";
import {
  InvalidIdError,
  MILESTONE_ID_RE,
  SLICE_ID_RE,
  TASK_ID_RE,
  assertMilestoneId,
  assertSliceId,
  assertTaskId,
  assertWorktreePath,
} from "../milestone-ids.ts";

// ─── Regex shape ────────────────────────────────────────────────────────────

test("MILESTONE_ID_RE accepts classic and unique-suffix forms", () => {
  assert.ok(MILESTONE_ID_RE.test("M001"));
  assert.ok(MILESTONE_ID_RE.test("M999"));
  assert.ok(MILESTONE_ID_RE.test("M001-abc123"));
  assert.ok(!MILESTONE_ID_RE.test("M01"));
  assert.ok(!MILESTONE_ID_RE.test("m001"));
  assert.ok(!MILESTONE_ID_RE.test("M001-ABC123"));
});

test("SLICE_ID_RE matches S## and rejects other shapes", () => {
  assert.ok(SLICE_ID_RE.test("S01"));
  assert.ok(SLICE_ID_RE.test("S99"));
  assert.ok(!SLICE_ID_RE.test("S1"));
  assert.ok(!SLICE_ID_RE.test("S100"));
  assert.ok(!SLICE_ID_RE.test("s01"));
  assert.ok(!SLICE_ID_RE.test("M01"));
});

test("TASK_ID_RE matches T## and rejects other shapes", () => {
  assert.ok(TASK_ID_RE.test("T01"));
  assert.ok(TASK_ID_RE.test("T99"));
  assert.ok(!TASK_ID_RE.test("T1"));
  assert.ok(!TASK_ID_RE.test("T100"));
  assert.ok(!TASK_ID_RE.test("t01"));
});

// ─── InvalidIdError shape ───────────────────────────────────────────────────

test("InvalidIdError carries kind/source/attemptedId fields", () => {
  const err = new InvalidIdError("milestone", "src/test", "M001'; DROP");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "InvalidIdError");
  assert.equal(err.kind, "milestone");
  assert.equal(err.source, "src/test");
  assert.equal(err.attemptedId, "M001'; DROP");
  assert.match(err.message, /milestone validation failed/);
  assert.match(err.message, /M001'; DROP/);
});

test("InvalidIdError default message uses JSON.stringify on attemptedId", () => {
  const err = new InvalidIdError("slice", "src", "S99\nrogue");
  // JSON.stringify escapes the newline so loggers don't break
  assert.match(err.message, /"S99\\nrogue"/);
});

test("InvalidIdError respects explicit message override", () => {
  const err = new InvalidIdError("task", "src", "T01", "boom");
  assert.equal(err.message, "boom");
});

// ─── assertMilestoneId ──────────────────────────────────────────────────────

test("assertMilestoneId accepts classic and unique IDs", () => {
  assert.doesNotThrow(() => assertMilestoneId("M001"));
  assert.doesNotThrow(() => assertMilestoneId("M042"));
  assert.doesNotThrow(() => assertMilestoneId("M001-abc123"));
});

test("assertMilestoneId throws InvalidIdError on malformed string", () => {
  assert.throws(() => assertMilestoneId("M01"), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "milestone" && err.attemptedId === "M01";
  });
});

test("assertMilestoneId throws InvalidIdError on SQL injection attempt", () => {
  assert.throws(() => assertMilestoneId("M001'; DROP TABLE"), (err: unknown) => {
    return err instanceof InvalidIdError
      && err.kind === "milestone"
      && err.attemptedId === "M001'; DROP TABLE";
  });
});

test("assertMilestoneId throws on empty string", () => {
  assert.throws(() => assertMilestoneId(""), InvalidIdError);
});

test("assertMilestoneId throws on null without TypeError", () => {
  assert.throws(() => assertMilestoneId(null as unknown as string), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "milestone" && err.attemptedId === "null";
  });
});

test("assertMilestoneId throws on undefined without TypeError", () => {
  assert.throws(() => assertMilestoneId(undefined as unknown as string), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "milestone";
  });
});

test("assertMilestoneId throws on number without TypeError", () => {
  assert.throws(() => assertMilestoneId(1 as unknown as string), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "milestone" && err.attemptedId === "1";
  });
});

test("assertMilestoneId default source is 'unknown'", () => {
  try {
    assertMilestoneId("bogus");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof InvalidIdError);
    assert.equal((err as InvalidIdError).source, "unknown");
  }
});

test("assertMilestoneId records explicit source", () => {
  try {
    assertMilestoneId("bogus", "discoverDbCompletedMilestones");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof InvalidIdError);
    assert.equal((err as InvalidIdError).source, "discoverDbCompletedMilestones");
  }
});

// ─── assertSliceId ──────────────────────────────────────────────────────────

test("assertSliceId accepts S##", () => {
  assert.doesNotThrow(() => assertSliceId("S01"));
  assert.doesNotThrow(() => assertSliceId("S42"));
});

test("assertSliceId throws InvalidIdError on malformed string", () => {
  assert.throws(() => assertSliceId("S1"), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "slice" && err.attemptedId === "S1";
  });
});

test("assertSliceId throws InvalidIdError on SQL injection attempt", () => {
  assert.throws(() => assertSliceId("S01'; DROP"), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "slice";
  });
});

test("assertSliceId throws on empty string", () => {
  assert.throws(() => assertSliceId(""), InvalidIdError);
});

test("assertSliceId throws on null without TypeError", () => {
  assert.throws(() => assertSliceId(null as unknown as string), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "slice";
  });
});

test("assertSliceId throws on undefined", () => {
  assert.throws(() => assertSliceId(undefined as unknown as string), InvalidIdError);
});

test("assertSliceId throws on number", () => {
  assert.throws(() => assertSliceId(7 as unknown as string), InvalidIdError);
});

// ─── assertTaskId ───────────────────────────────────────────────────────────

test("assertTaskId accepts T##", () => {
  assert.doesNotThrow(() => assertTaskId("T01"));
  assert.doesNotThrow(() => assertTaskId("T99"));
});

test("assertTaskId throws InvalidIdError on malformed string", () => {
  assert.throws(() => assertTaskId("T1"), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "task" && err.attemptedId === "T1";
  });
});

test("assertTaskId throws InvalidIdError on SQL injection attempt", () => {
  assert.throws(() => assertTaskId("T01'; DROP"), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "task";
  });
});

test("assertTaskId throws on empty string", () => {
  assert.throws(() => assertTaskId(""), InvalidIdError);
});

test("assertTaskId throws on null without TypeError", () => {
  assert.throws(() => assertTaskId(null as unknown as string), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "task";
  });
});

test("assertTaskId throws on undefined", () => {
  assert.throws(() => assertTaskId(undefined as unknown as string), InvalidIdError);
});

test("assertTaskId throws on number", () => {
  assert.throws(() => assertTaskId(3 as unknown as string), InvalidIdError);
});

// ─── assertWorktreePath ─────────────────────────────────────────────────────

test("assertWorktreePath accepts a normalised absolute POSIX path with milestone basename", () => {
  assert.doesNotThrow(() => assertWorktreePath("/tmp/.gsd/worktrees/M001"));
  assert.doesNotThrow(() => assertWorktreePath("/var/data/M042-abc123"));
});

test("assertWorktreePath throws InvalidIdError on non-string input", () => {
  assert.throws(() => assertWorktreePath(null as unknown as string), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "worktree-path";
  });
  assert.throws(() => assertWorktreePath(undefined as unknown as string), InvalidIdError);
  assert.throws(() => assertWorktreePath(42 as unknown as string), InvalidIdError);
});

test("assertWorktreePath throws on traversal segment (../)", () => {
  assert.throws(() => assertWorktreePath("/foo/../M001"), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "worktree-path";
  });
});

test("assertWorktreePath throws on NUL byte", () => {
  assert.throws(() => assertWorktreePath("/foo/\0/M001"), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "worktree-path";
  });
});

test("assertWorktreePath throws on backslash (POSIX-strict)", () => {
  assert.throws(() => assertWorktreePath("/foo\\M001"), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "worktree-path";
  });
});

test("assertWorktreePath throws on non-absolute path", () => {
  assert.throws(() => assertWorktreePath("./M001"), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "worktree-path";
  });
  assert.throws(() => assertWorktreePath("M001"), InvalidIdError);
});

test("assertWorktreePath throws on un-normalised path (double slash)", () => {
  assert.throws(() => assertWorktreePath("/foo//M001"), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "worktree-path";
  });
});

test("assertWorktreePath throws on un-normalised path (trailing slash)", () => {
  assert.throws(() => assertWorktreePath("/foo/M001/"), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "worktree-path";
  });
});

test("assertWorktreePath throws when basename is not a milestone id", () => {
  assert.throws(() => assertWorktreePath("/tmp/not-a-milestone"), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "worktree-path";
  });
});

test("assertWorktreePath throws on SQL injection in basename", () => {
  assert.throws(() => assertWorktreePath("/tmp/M001'; DROP TABLE--"), (err: unknown) => {
    return err instanceof InvalidIdError && err.kind === "worktree-path";
  });
});

test("assertWorktreePath records explicit source", () => {
  try {
    assertWorktreePath("/bogus", "querySliceProgress");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof InvalidIdError);
    assert.equal((err as InvalidIdError).source, "querySliceProgress");
  }
});

test("assertWorktreePath default source is 'unknown'", () => {
  try {
    assertWorktreePath("/bogus");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof InvalidIdError);
    assert.equal((err as InvalidIdError).source, "unknown");
  }
});
