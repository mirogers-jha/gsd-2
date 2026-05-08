/**
 * Parallel sqlite3 CLI seam — the deterministic interleaving point (D005)
 * shared by `parallel-merge.ts` and `parallel-monitor-overlay.ts`.
 *
 * Why this module exists:
 *   The three sqlite3 CLI spawn sites in the parallel-* file cluster
 *   compose SQL with worktree directory names taken from `readdirSync`.
 *   A malicious directory like `M001'; DROP TABLE--` would otherwise reach
 *   the shell. This wrapper validates the milestone ID *before* the runner
 *   is invoked and lets `InvalidIdError` bubble synchronously so call sites
 *   can structurally log + skip the entry (CRITICAL #3, S01).
 *
 * Why a dedicated tiny module (S01-RESEARCH Option A):
 *   Both `parallel-merge.ts` and `parallel-monitor-overlay.ts` need the
 *   seam. Putting it in either of them creates a circular import; putting
 *   it in `milestone-ids.ts` couples a leaf utility module to `node:child_process`.
 *   A small focused module avoids both pitfalls and keeps the test seam
 *   (`_setSqliteRunnerForTests`) co-located with the wrapper.
 *
 * Direct-import only — do NOT re-export `runSqliteCli` from a barrel. The
 * call sites catch `InvalidIdError instanceof` and re-exporting through a
 * barrel can break `instanceof` across module-resolution boundaries
 * (S01-RESEARCH pitfall).
 */

import { spawnSync } from "node:child_process";
import { assertMilestoneId } from "./milestone-ids.js";

/**
 * Result shape for a single sqlite3 CLI invocation.
 *
 * `status` is `null` when spawnSync was killed by signal (timeout / SIGTERM).
 * The existing call sites at parallel-merge.ts:47 and parallel-monitor-overlay
 * only inspect `stdout`, so we preserve that shape verbatim instead of switching
 * to a `status === 0` check (S01-RESEARCH pitfall on signal-kill behaviour).
 */
export interface SqliteCliResult {
  stdout: string;
  status: number | null;
  error?: Error;
}

/**
 * Public arguments for `runSqliteCli`. `mid` is validated before the runner
 * is invoked; `dbPath` and `sql` are passed through unchanged.
 */
export interface SqliteCliArgs {
  dbPath: string;
  sql: string;
  mid: string;
  /** Defaults to 3000ms — matches the existing inline spawnSync calls. */
  timeoutMs?: number;
}

/**
 * Underlying spawn function. Pulled out so tests can inject a fake via
 * `_setSqliteRunnerForTests` without spawning the real `sqlite3` binary
 * (D005 — the seam IS the deterministic interleaving point).
 */
export type SqliteRunner = (args: {
  dbPath: string;
  sql: string;
  timeoutMs: number;
}) => SqliteCliResult;

/**
 * Default runner — verbatim mirror of the existing spawnSync call shape at
 * parallel-merge.ts:47, including the `(e as Error)` catch and the
 * `{ stdout: '', status: null, error: e }` shape on throw.
 */
const defaultRunner: SqliteRunner = ({ dbPath, sql, timeoutMs }) => {
  try {
    const result = spawnSync("sqlite3", [dbPath, sql], {
      timeout: timeoutMs,
      encoding: "utf-8",
    });
    return {
      stdout: result.stdout ?? "",
      status: result.status,
    };
  } catch (e) {
    return { stdout: "", status: null, error: e as Error };
  }
};

/**
 * Module-level mutable runner. `_setSqliteRunnerForTests` mutates this so
 * test fakes are visible to the wrapper without round-tripping through
 * the consumer call sites.
 */
let activeRunner: SqliteRunner = defaultRunner;

/**
 * Validate the milestone ID, then delegate to the active runner. Lets
 * `InvalidIdError` bubble synchronously — the wrapper does NOT catch.
 *
 * Call sites are responsible for the structured `logError("parallel", ...)`
 * step (T03) so log context stays accurate per-site.
 */
export function runSqliteCli(args: SqliteCliArgs): SqliteCliResult {
  assertMilestoneId(args.mid, "runSqliteCli");
  return activeRunner({
    dbPath: args.dbPath,
    sql: args.sql,
    timeoutMs: args.timeoutMs ?? 3000,
  });
}

/**
 * Test-only seam. Pass a runner to install it; pass `null` to reset to
 * the default. Underscore-prefixed to signal "not for production use".
 */
export function _setSqliteRunnerForTests(runner: SqliteRunner | null): void {
  activeRunner = runner ?? defaultRunner;
}
