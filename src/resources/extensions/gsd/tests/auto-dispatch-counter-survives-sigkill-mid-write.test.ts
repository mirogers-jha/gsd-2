/**
 * D004 reproduce-and-prevent for the SIGKILL crash window in the auto-dispatch
 * counter rewrite (M002/S01/T03).
 *
 * Bug: if the process is SIGKILLed AFTER `writeFileSync` has begun streaming
 * bytes to the destination but BEFORE it has completed (or fsync'd), the
 * counter file is left truncated/partial. Reading it back returns either a
 * `JSON.parse` failure (silently caught → counter resets to 0 → circuit
 * breaker disarmed → infinite rewrite loop) or, worse, a parseable-but-wrong
 * value (silent data loss).
 *
 * Fix: route the write through `atomicWriteSync` (temp + rename). SIGKILL
 * during the temp-file write leaves the original destination untouched;
 * SIGKILL during rename is itself atomic at the syscall level (POSIX rename
 * is atomic with respect to crashes) — the destination is either the OLD
 * inode or the NEW inode, never partial.
 *
 * Reproduction strategy (deterministic at the seam, not at the kernel):
 *   - Spawn a child Node process.
 *   - Child seeds a counter file at a known path.
 *   - Child calls `setRewriteCountWithOps` with an `AtomicWriteSyncOps` that
 *     uses real disk I/O for `mkdir` + `writeFile` + `unlink`, but whose
 *     `rename` calls `process.kill(process.pid, 'SIGKILL')` BEFORE invoking
 *     the real `renameSync`.
 *   - Child dies with signal SIGKILL (exit code null, signal "SIGKILL").
 *   - Parent asserts:
 *       (a) the seed counter file is byte-for-byte unchanged
 *       (b) no parse-corrupted JSON wedged the read path
 *       (c) any leftover `.tmp.*` is the temp file (not the destination)
 *
 * To verify D004 manually: revert the production code so `setRewriteCount`
 * calls `writeFileSync(filePath, ...)` directly. Re-run a SIGKILL repro that
 * kills the child mid-`writeFileSync` (e.g. setTimeout + process.kill against
 * a much larger payload) — the seed file will be truncated/empty/partial,
 * which this test would catch by failing the byte-identical assertion.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SEED_REWRITE = JSON.stringify({ count: 4, updatedAt: "2026-04-01T00:00:00.000Z" }) + "\n";
const SEED_UAT = JSON.stringify({ count: 1, updatedAt: "2026-04-01T00:00:00.000Z" }) + "\n";

/**
 * Build a child-process script that:
 *   1. imports the compiled auto-dispatch.js + atomic-write.js from dist-test
 *   2. constructs an AtomicWriteSyncOps that real-writes the temp file but
 *      SIGKILLs self before invoking renameSync
 *   3. calls the requested counter writer
 *
 * Returned as a JS string so we can pass it via `node -e`.
 */
function buildChildScript(target: "rewrite" | "uat", project: string): string {
  // Resolve the compiled module paths from THIS test file's location.
  // This file at runtime lives at dist-test/resources/extensions/gsd/tests/...
  // The compiled siblings are in the same directory.
  const distDir = __dirname;
  // Resolve auto-dispatch by trying compiled .js first (test:unit:compiled
  // path runs from dist-test/), then .ts (test:coverage runs from src/ via
  // --experimental-strip-types). Both are valid module identifiers Node can
  // load — the .ts variant requires Node ≥22 + --experimental-strip-types,
  // which is the project baseline. The caller adjusts child spawn args
  // accordingly via childSpawnArgs() below.
  const autoDispatchJs = join(distDir, "..", "auto-dispatch.js");
  const autoDispatchTs = join(distDir, "..", "auto-dispatch.ts");
  const autoDispatchPath = existsSync(autoDispatchJs) ? autoDispatchJs : autoDispatchTs;
  const escape = (p: string) => p.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  const callExpression =
    target === "rewrite"
      ? `setRewriteCountWithOps('${escape(project)}', 99, ops);`
      : `incrementUatCountWithOps('${escape(project)}', 'M002', 'S01', ops);`;

  return `
    import { mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
    import { setRewriteCountWithOps, incrementUatCountWithOps } from '${escape(autoDispatchPath)}';

    // Real disk I/O for everything EXCEPT rename. Rename SIGKILLs self
    // BEFORE the real renameSync runs — simulates a crash in the rename
    // window (crash-during-temp-write window is covered by the byte-identical
    // assertion since the temp file is not the destination).
    const ops = {
      mkdir: (p, opts) => mkdirSync(p, opts),
      writeFile: (p, content, encoding) => writeFileSync(p, content, encoding),
      rename: (from, to) => {
        // The temp file at \`from\` is now on disk. Kill before rename completes.
        process.kill(process.pid, 'SIGKILL');
        // Unreachable, but keep TS happy — never call the real rename.
        renameSync(from, to);
      },
      unlink: (p) => unlinkSync(p),
      sleep: () => {},
      createTempPath: (filePath) => filePath + '.tmp.sigkill-test',
    };

    ${callExpression}
    // If we reach here, the SIGKILL did not fire — fail the run.
    process.exit(42);
  `;
}

/**
 * Build child Node spawn args. When auto-dispatch is loaded from .ts (the
 * `test:coverage` source-strip path), the child needs `--experimental-strip-types`
 * to import it — otherwise Node throws ERR_MODULE_NOT_FOUND for the .ts URL.
 * Under `test:unit:compiled` we load .js and no extra flag is needed.
 */
function childSpawnArgs(script: string): string[] {
  const distDir = __dirname;
  const usingTs = !existsSync(join(distDir, "..", "auto-dispatch.js"));
  if (usingTs) {
    // test:coverage path: source-strip the .ts module and apply the same
    // .js→.ts resolver hook the parent test runner uses, so internal imports
    // like `./files.js` resolve to the .ts sibling.
    const resolverHook = join(distDir, "resolve-ts.mjs");
    return [
      "--import",
      pathToFileURL(resolverHook).href,
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      script,
    ];
  }
  // test:unit:compiled path: load the .js sibling directly, no extra hooks.
  return ["--input-type=module", "-e", script];
}

function makeProject(): string {
  // realpath: gsdRoot() canonicalizes via realpathSync. On macOS the tmpdir
  // /var symlinks to /private/var; the child process resolves the same
  // canonical form, so the parent must too in order to read the seed file
  // back from the right location.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-m002-s01-t03-sigkill-")));
  mkdirSync(join(root, ".gsd", "runtime"), { recursive: true });
  return root;
}

test("setRewriteCount — SIGKILL between temp-write and rename leaves seed counter byte-identical", () => {
  const project = makeProject();
  const counterPath = join(project, ".gsd", "runtime", "rewrite-count.json");
  writeFileSync(counterPath, SEED_REWRITE, "utf-8");

  try {
    const script = buildChildScript("rewrite", project);

    // spawnSync — execFileSync throws on non-zero exit which is exactly what
    // we expect (SIGKILL → status null, signal SIGKILL). spawnSync returns a
    // structured result we can introspect.
    const result = spawnSync(
      process.execPath,
      childSpawnArgs(script),
      { encoding: "utf-8", timeout: 10_000 },
    );

    // 1. Child died via SIGKILL, not a clean exit / not exit code 42.
    assert.equal(
      result.signal,
      "SIGKILL",
      `child must die via SIGKILL (proves the kill fired before rename). signal=${result.signal} status=${result.status} stderr=${result.stderr}`,
    );
    assert.notEqual(result.status, 42, "child must NOT have reached the unreachable post-call line");

    // 2. Seed file is byte-for-byte unchanged. The destination inode was
    //    never touched: writeFileSync wrote to the .tmp.* sibling, and
    //    renameSync was killed before invocation.
    const onDisk = readFileSync(counterPath, "utf-8");
    assert.equal(onDisk, SEED_REWRITE, "rewrite-count.json must be byte-identical to seed after SIGKILL");

    // 3. Counter still parses to the original value (no silent corruption).
    const parsed = JSON.parse(onDisk);
    assert.equal(parsed.count, 4, "circuit-breaker counter must read pre-crash value");

    // 4. If a .tmp.* orphan remains, it is the temp sibling — NOT the live
    //    counter path. The atomicity guarantee is on the destination, not
    //    on cleanup of crash debris (that is what `auto-recovery` sweeps).
    const filesInRuntime = readdirSync(join(project, ".gsd", "runtime"));
    const orphans = filesInRuntime.filter((f) => f.includes(".tmp."));
    for (const orphan of orphans) {
      assert.ok(
        orphan.startsWith("rewrite-count.json.tmp."),
        `crash debris must be a temp sibling, not the live counter path; got: ${orphan}`,
      );
      // Orphan is allowed but verify it's the temp sibling, not a renamed-then-truncated dest.
      // (Reading it should give the *new* payload that never made it to dest.)
      const orphanContent = readFileSync(join(project, ".gsd", "runtime", orphan), "utf-8");
      assert.notEqual(
        orphanContent,
        SEED_REWRITE,
        "temp sibling must contain the NEW payload (the write completed before kill); proves kill fired in rename, not writeFile",
      );
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("incrementUatCount — SIGKILL between temp-write and rename leaves seed counter byte-identical", () => {
  const project = makeProject();
  const counterPath = join(project, ".gsd", "runtime", "uat-count-M002-S01.json");
  writeFileSync(counterPath, SEED_UAT, "utf-8");

  try {
    const script = buildChildScript("uat", project);
    const result = spawnSync(
      process.execPath,
      childSpawnArgs(script),
      { encoding: "utf-8", timeout: 10_000 },
    );

    assert.equal(
      result.signal,
      "SIGKILL",
      `child must die via SIGKILL. signal=${result.signal} status=${result.status} stderr=${result.stderr}`,
    );
    assert.notEqual(result.status, 42, "child must NOT have reached the unreachable post-call line");

    const onDisk = readFileSync(counterPath, "utf-8");
    assert.equal(onDisk, SEED_UAT, "uat-count file must be byte-identical to seed after SIGKILL");
    const parsed = JSON.parse(onDisk);
    assert.equal(parsed.count, 1, "per-slice counter must read pre-crash value");

    const filesInRuntime = readdirSync(join(project, ".gsd", "runtime"));
    const orphans = filesInRuntime.filter((f) => f.includes(".tmp."));
    for (const orphan of orphans) {
      assert.ok(
        orphan.startsWith("uat-count-M002-S01.json.tmp."),
        `crash debris must be a temp sibling; got: ${orphan}`,
      );
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// Suppress unused import warning when execFileSync is referenced for parity.
void execFileSync;
