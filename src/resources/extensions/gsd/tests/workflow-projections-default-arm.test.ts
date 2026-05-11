/**
 * D004 reproduce-and-prevent — M003/S05 Bug 2
 *
 * `workflow-projections.ts:regenerateIfMissing` had a switch on `fileType`
 * covering 'PLAN'|'ROADMAP'|'SUMMARY'|'STATE' but NO `default:` arm.
 * If a future caller (or runtime cast) passed an unknown fileType, `filePath`
 * stayed unassigned and the downstream `existsSync(filePath)` threw the
 * opaque, non-actionable `TypeError: The "path" argument must be of type
 * string. Received undefined`.
 *
 * Fix: hard-fail at the boundary with `throw new Error(\`Unsupported
 * regenerateIfMissing fileType: ${fileType}\`)`. Surfaces missing future
 * cases instead of letting downstream code throw obliquely.
 *
 * Pre-fix RED proof: delete the `default:` arm; sub-case 2A (unknown type)
 * throws TypeError from existsSync(undefined) instead of the structured
 * Error. Restore → GREEN.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { regenerateIfMissing } from "../workflow-projections.ts";

function makeTmpBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-projections-default-arm-"));
  // Make .gsd subdir so STATE.md path resolution works
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}

describe("regenerateIfMissing default-arm hard-fail (M003/S05 Bug 2)", () => {
  it("2A: throws structured Error for unknown fileType (post-fix; pre-fix would TypeError from existsSync(undefined))", async () => {
    const base = makeTmpBase();
    try {
      await assert.rejects(
        // @ts-expect-error — intentionally passing an out-of-union value to drive the default arm
        regenerateIfMissing(base, "M001", "S01", "UNKNOWN_TYPE"),
        (err: Error) => {
          // Post-fix assertion: structured boundary error.
          // If the default arm is missing (pre-fix), this would be a
          // TypeError mentioning `path` / `Received undefined` instead.
          assert.match(
            err.message,
            /Unsupported regenerateIfMissing fileType: UNKNOWN_TYPE/,
            `expected structured boundary error; got: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("2B: PLAN (existing case) does not throw — returns boolean", async () => {
    // Positive control: existing case still routes through the switch and
    // does not trigger the default arm. PLAN file does not exist → either
    // regeneration attempted (returns true) or silently noop'd by the
    // catch (returns false). Either way: a boolean, no throw.
    const base = makeTmpBase();
    try {
      const result = await regenerateIfMissing(base, "M001", "S01", "PLAN");
      assert.equal(typeof result, "boolean", "PLAN case must return a boolean (not throw)");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("2C: STATE (existing case) does not throw — returns boolean", async () => {
    // Positive control: STATE case (a different switch arm) still works.
    // STATE.md missing → renderStateProjection invoked; any DB-init failure
    // is caught and returns false. Assertion: no throw, boolean returned.
    const base = makeTmpBase();
    try {
      const result = await regenerateIfMissing(base, "M001", "S01", "STATE");
      assert.equal(typeof result, "boolean", "STATE case must return a boolean (not throw)");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
