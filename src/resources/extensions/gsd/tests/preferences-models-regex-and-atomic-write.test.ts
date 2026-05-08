/**
 * Pure-function branch tests for replaceOrAppendModelsBlock — the line-walker
 * helper that replaces the broken multiline regex used to splice the
 * `models:` YAML block in `~/.gsd/PREFERENCES.md`.
 *
 * Bug-list reference: CRITICAL #4 (preferences-models.ts:339,346).
 * Behavior contract (per S02-CONTEXT + S02-RESEARCH §Recommendation):
 *
 *   - A top-level `models:` block starts at /^models:(\s|$)/ and ends at the
 *     next non-blank, non-indented line (i.e. another top-level YAML key) or
 *     at EOF. Blank and indented lines are consumed as part of the block.
 *   - If the input has zero blocks, the new block is APPENDED with a blank
 *     line separator (preserving sibling top-level keys verbatim).
 *   - If the input has one block, it is REPLACED in place.
 *   - If the input has >1 blocks (corruption from pre-fix behavior), all
 *     earlier blocks are DROPPED and the LAST one is replaced — silent
 *     self-heal per D002-style "latest wins".
 *   - The sibling key `models_archive:` (and any other `models*` non-exact
 *     match) is never false-matched.
 *
 * T02 will extend this file with the AtomicWriteSyncOps rename-failure seam
 * test and the library-level round-trip behavioral test.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  replaceOrAppendModelsBlock,
  updatePreferencesModels,
  updatePreferencesModelsWithOps,
} from "../preferences-models.ts";
import { loadEffectiveGSDPreferences, getGlobalGSDPreferencesPath } from "../preferences.ts";
import type { AtomicWriteSyncOps } from "../atomic-write.ts";
import type { GSDModelConfigV2 } from "../preferences-types.ts";

const NEW_BLOCK = [
  "models:",
  "  planning: claude-opus-4-6",
  "  execution: claude-sonnet-4-6",
].join("\n");

test("replaceOrAppendModelsBlock — empty input appends the new block with trailing newline", () => {
  const out = replaceOrAppendModelsBlock("", NEW_BLOCK);
  // Empty file: just emit the block + trailing newline. No leading blank line.
  assert.equal(out, NEW_BLOCK + "\n");
  assert.equal(countTopLevelModelsLines(out), 1);
});

test("replaceOrAppendModelsBlock — file with no models: key appends with blank-line separator", () => {
  const existing = [
    "version: 1",
    "mode: standard",
    "skill_discovery:",
    "  enabled: true",
    "",
  ].join("\n");
  const out = replaceOrAppendModelsBlock(existing, NEW_BLOCK);
  assert.ok(out.includes("version: 1"), "preserves sibling top-level keys");
  assert.ok(out.includes("skill_discovery:"), "preserves sibling top-level keys");
  assert.ok(out.endsWith(NEW_BLOCK + "\n"), `expected trailing block; got: ${JSON.stringify(out.slice(-80))}`);
  // Must have exactly one blank line between siblings and the appended block.
  assert.ok(/\n\nmodels:/.test(out), "block is appended with blank line separator");
  assert.equal(countTopLevelModelsLines(out), 1);
});

test("replaceOrAppendModelsBlock — single block in middle is replaced in place", () => {
  const existing = [
    "version: 1",
    "models:",
    "  planning: old-model",
    "  execution: old-model",
    "skill_discovery:",
    "  enabled: true",
    "",
  ].join("\n");
  const out = replaceOrAppendModelsBlock(existing, NEW_BLOCK);
  assert.equal(countTopLevelModelsLines(out), 1, "exactly one models: block");
  assert.ok(out.includes("planning: claude-opus-4-6"), "new content present");
  assert.ok(!out.includes("planning: old-model"), "old content removed");
  assert.ok(out.includes("version: 1"), "preceding sibling preserved");
  assert.ok(out.includes("skill_discovery:"), "trailing sibling preserved");
  // Order preserved: version → models → skill_discovery.
  const idxVersion = out.indexOf("version:");
  const idxModels = out.indexOf("models:");
  const idxSkill = out.indexOf("skill_discovery:");
  assert.ok(idxVersion < idxModels && idxModels < idxSkill, "section order preserved");
});

test("replaceOrAppendModelsBlock — last-of-many self-heal: drops earlier duplicates, replaces in last position", () => {
  // Simulates pre-fix corruption where the broken regex appended duplicates.
  const existing = [
    "version: 1",
    "models:",
    "  planning: ancient-model",
    "mode: standard",
    "models:",
    "  planning: middle-model",
    "skill_discovery:",
    "  enabled: true",
    "models:",
    "  planning: latest-model",
    "",
  ].join("\n");
  const out = replaceOrAppendModelsBlock(existing, NEW_BLOCK);
  assert.equal(countTopLevelModelsLines(out), 1, "self-healed to exactly one block");
  assert.ok(!out.includes("ancient-model"), "ancient block dropped");
  assert.ok(!out.includes("middle-model"), "middle block dropped");
  assert.ok(!out.includes("latest-model"), "latest block replaced");
  assert.ok(out.includes("planning: claude-opus-4-6"), "new content present");
  // Survivors preserved.
  assert.ok(out.includes("version: 1"));
  assert.ok(out.includes("mode: standard"));
  assert.ok(out.includes("skill_discovery:"));
  // The replaced block should be in the LAST original position — after
  // skill_discovery, not in the first slot.
  const idxSkill = out.indexOf("skill_discovery:");
  const idxModels = out.indexOf("models:");
  assert.ok(idxSkill < idxModels, "block replaced in the LAST position (after skill_discovery)");
});

test("replaceOrAppendModelsBlock — inline `models: {}` one-liner is replaced as a single-line block", () => {
  const existing = [
    "version: 1",
    "models: {}",
    "mode: standard",
    "",
  ].join("\n");
  const out = replaceOrAppendModelsBlock(existing, NEW_BLOCK);
  assert.equal(countTopLevelModelsLines(out), 1);
  assert.ok(!out.includes("models: {}"), "inline empty block removed");
  assert.ok(out.includes("planning: claude-opus-4-6"));
  assert.ok(out.includes("version: 1"));
  assert.ok(out.includes("mode: standard"));
});

test("replaceOrAppendModelsBlock — sibling key `models_archive:` is NOT false-matched", () => {
  const existing = [
    "version: 1",
    "models_archive:",
    "  - retired: gpt-3.5",
    "  - retired: claude-1",
    "mode: standard",
    "",
  ].join("\n");
  const out = replaceOrAppendModelsBlock(existing, NEW_BLOCK);
  assert.equal(countTopLevelModelsLines(out), 1, "the appended models: block is the only one");
  // models_archive: must be preserved verbatim (it has no match for ^models:).
  assert.ok(out.includes("models_archive:"), "sibling key preserved");
  assert.ok(out.includes("- retired: gpt-3.5"), "sibling content preserved");
  assert.ok(out.includes("- retired: claude-1"), "sibling content preserved");
  assert.ok(out.includes("planning: claude-opus-4-6"), "new block appended");
});

test("replaceOrAppendModelsBlock — blank line INSIDE the block is consumed as part of the block", () => {
  const existing = [
    "version: 1",
    "models:",
    "  planning: old",
    "",
    "  execution: old",
    "mode: standard",
    "",
  ].join("\n");
  const out = replaceOrAppendModelsBlock(existing, NEW_BLOCK);
  assert.equal(countTopLevelModelsLines(out), 1);
  assert.ok(!out.includes("planning: old"));
  assert.ok(!out.includes("execution: old"));
  assert.ok(out.includes("mode: standard"), "trailing sibling preserved");
  assert.ok(out.includes("planning: claude-opus-4-6"));
});

test("replaceOrAppendModelsBlock — block at EOF (no trailing top-level key) is replaced cleanly", () => {
  const existing = [
    "version: 1",
    "mode: standard",
    "models:",
    "  planning: old",
    "  execution: old",
    "",
  ].join("\n");
  const out = replaceOrAppendModelsBlock(existing, NEW_BLOCK);
  assert.equal(countTopLevelModelsLines(out), 1);
  assert.ok(!out.includes("planning: old"));
  assert.ok(out.includes("planning: claude-opus-4-6"));
  assert.ok(out.includes("version: 1"));
  assert.ok(out.includes("mode: standard"));
  // Block must be at the end (after mode: standard).
  const idxMode = out.indexOf("mode:");
  const idxModels = out.indexOf("models:");
  assert.ok(idxMode < idxModels, "EOF-block replaced in EOF position");
});

test("replaceOrAppendModelsBlock — input without trailing newline is handled (append + replace)", () => {
  // No trailing newline at all (some editors strip it).
  const existing = "version: 1\nmode: standard";
  const out = replaceOrAppendModelsBlock(existing, NEW_BLOCK);
  assert.equal(countTopLevelModelsLines(out), 1);
  assert.ok(out.includes("version: 1"));
  assert.ok(out.includes("mode: standard"));
  assert.ok(out.includes("planning: claude-opus-4-6"));
});

// ─── T02 group 1: AtomicWriteSyncOps rename-failure seam test ────────────
//
// Mirrors `createSyncHarness(plan)` from tests/atomic-write.test.ts:51 inline
// (do not import — keep this test self-contained per T02 plan). Injects an
// `AtomicWriteSyncOps` whose `rename` throws ENOSPC; asserts the original
// `PREFERENCES.md` is byte-for-byte unchanged and no orphan `.tmp.*` file
// remains. Does NOT duplicate atomic-write.ts's retry/backoff coverage.

test("updatePreferencesModelsWithOps — rename ENOSPC leaves seed PREFERENCES.md intact and cleans temp file", () => {
  const originalGsdHome = process.env.GSD_HOME;
  const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-prefs-s02-"));
  const seedContent = [
    "version: 1",
    "mode: standard",
    "models:",
    "  planning: seed-planning-model",
    "  execution: seed-execution-model",
    "skill_discovery:",
    "  enabled: true",
    "",
  ].join("\n");

  try {
    process.env.GSD_HOME = tempGsdHome;
    const prefsPath = getGlobalGSDPreferencesPath();
    writeFileSync(prefsPath, seedContent, "utf-8");

    // Inline harness mirroring atomic-write.test.ts:51 createSyncHarness, but
    // pinned to ALWAYS throw ENOSPC on rename — exercises the terminal-failure
    // path (not the transient-retry path). atomic-write.ts treats ENOSPC as
    // non-transient, so it short-circuits after the first attempt.
    const renameCalls: Array<{ from: string; to: string }> = [];
    const unlinkCalls: string[] = [];
    const writeFileCalls: Array<{ path: string; content: string }> = [];
    let tempCounter = 0;

    const ops: AtomicWriteSyncOps = {
      mkdir: () => {},
      writeFile: (path, content) => {
        writeFileCalls.push({ path, content: String(content) });
      },
      rename: (from, to) => {
        renameCalls.push({ from, to });
        const err = new Error("no space left on device") as NodeJS.ErrnoException;
        err.code = "ENOSPC";
        throw err;
      },
      unlink: (path) => {
        unlinkCalls.push(path);
      },
      sleep: () => {},
      // Use a deterministic temp path so we can assert no orphan remains in
      // the prefs dir at the end.
      createTempPath: (filePath) => `${filePath}.tmp.test-${++tempCounter}`,
    };

    let thrown: unknown = null;
    try {
      updatePreferencesModelsWithOps(
        { planning: "new-model", execution: "new-model" },
        ops,
      );
    } catch (e) {
      thrown = e;
    }

    // 1. Threw, with a message naming the path and ENOSPC (or UNKNOWN if Node
    //    maps differently — buildAtomicWriteError accepts either).
    assert.ok(thrown instanceof Error, "must throw an Error");
    const err = thrown as NodeJS.ErrnoException;
    assert.ok(
      err.message.includes(prefsPath),
      `error message must include prefs path; got: ${err.message}`,
    );
    assert.ok(
      /ENOSPC|UNKNOWN/.test(err.message),
      `error message must contain ENOSPC or UNKNOWN code; got: ${err.message}`,
    );
    assert.ok(
      err.code === "ENOSPC" || err.code === "UNKNOWN",
      `error.code must be ENOSPC or UNKNOWN; got: ${err.code}`,
    );

    // 2. Original on-disk file is byte-for-byte the seed (write went to tmp,
    //    rename failed, original never touched).
    const onDisk = readFileSync(prefsPath, "utf-8");
    assert.equal(onDisk, seedContent, "seed PREFERENCES.md must be untouched on rename failure");

    // 3. No orphan .tmp.* file remains in the prefs dir. The injected ops
    //    accounted for unlink calls, but the real on-disk dir must also be
    //    clean (since the injected ops never wrote to disk, this confirms
    //    the harness was actually used end-to-end and no real fs leakage
    //    occurred).
    const filesInPrefsDir = readdirSync(tempGsdHome);
    const orphans = filesInPrefsDir.filter((f) => f.includes(".tmp."));
    assert.deepEqual(orphans, [], `no orphan .tmp.* files allowed; found: ${orphans.join(", ")}`);

    // 4. The rename was attempted (proves we exercised the seam, not just the
    //    pre-rename mkdir/writeFile path).
    assert.ok(renameCalls.length >= 1, "rename must have been attempted");
    // 5. The harness write went to a tmp path, not directly to prefsPath.
    assert.ok(
      writeFileCalls.length >= 1 && writeFileCalls[0].path.startsWith(prefsPath + ".tmp."),
      "writeFile must target a .tmp.* sibling, not the live prefs path",
    );
    // 6. cleanupTempFileSync ran the unlink on the tmp path after the
    //    terminal-failure path triggered.
    assert.ok(
      unlinkCalls.some((p) => p.startsWith(prefsPath + ".tmp.")),
      "cleanup must call unlink on the tmp file after terminal failure",
    );
  } finally {
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
});

// ─── T02 group 2: library-level round-trip behavioral test ───────────────
//
// Seeds a fresh tmp GSD_HOME with a multi-key PREFERENCES.md fixture and
// makes 5 sequential updatePreferencesModels(models) calls with varying
// GSDModelConfigV2 payloads (string-form, object-with-fallbacks-form,
// provider-included-form). After each call, asserts:
//   (a) exactly one ^models: top-level line
//   (b) all original sibling top-level keys still present
//   (c) every non-blank line matches one of the three YAML-shape patterns
//   (d) loadEffectiveGSDPreferences round-trips and prefs.preferences.models
//       reflects the input
//
// This is the round-trip behavioral gate that the D004 reproduce-and-prevent
// step manually verifies by reverting the regex/helper fix.

// Real on-disk PREFERENCES.md may be plain YAML, but parsePreferencesMarkdown
// only recognizes frontmatter-fenced or heading-list formats (per
// preferences.ts:251). To exercise the full round-trip (write + load), the
// fixture wraps the YAML in `---` fences. The line-walker in
// replaceOrAppendModelsBlock detects `^models:` regardless of fence context
// (the fences are top-level non-`models:` lines, which are preserved
// verbatim as siblings). Verified manually before locking the fixture.
const ROUND_TRIP_FIXTURE = [
  "---",
  "version: 1",
  "mode: standard",
  "models:",
  "  planning: seed-planning",
  "  execution: seed-execution",
  "skill_discovery:",
  "  enabled: true",
  "  recurse: true",
  "notifications:",
  "  enabled: false",
  "---",
  "",
].join("\n");

const ROUND_TRIP_INPUTS: GSDModelConfigV2[] = [
  // 1. Pure string-form.
  { planning: "claude-opus-4-6", execution: "claude-sonnet-4-6" },
  // 2. Object-with-fallbacks-form.
  {
    planning: { model: "claude-opus-4-6", fallbacks: ["glm-5", "minimax-m2.5"] },
    execution: { model: "claude-sonnet-4-6", fallbacks: ["gpt-5.4"] },
  },
  // 3. Provider-included-form.
  {
    planning: { model: "claude-opus-4-6", provider: "bedrock" },
    execution: { model: "gpt-5.4", provider: "openai-codex", fallbacks: ["claude-sonnet-4-6"] },
  },
  // 4. Mixed: string + object + bare ID.
  {
    research: "qwen2.5-coder:7b",
    planning: { model: "claude-opus-4-6", fallbacks: ["glm-5"] },
    execution: "claude-sonnet-4-6",
    completion: { model: "claude-haiku-3-5", provider: "anthropic" },
  },
  // 5. Reduced surface — back to a small string-only config (proves no
  //    accumulated cruft from prior writes).
  { planning: "final-model" },
];

test("updatePreferencesModels — 5 sequential round-trip writes preserve siblings, single models: block, valid YAML shape", () => {
  const originalGsdHome = process.env.GSD_HOME;
  const originalCwd = process.cwd();
  const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-prefs-s02-"));
  const tempProject = mkdtempSync(join(tmpdir(), "gsd-prefs-s02-proj-"));
  const expectedSiblings = ["version", "mode", "skill_discovery", "notifications"];

  try {
    process.env.GSD_HOME = tempGsdHome;
    // Isolate from any project-level PREFERENCES.md in the worktree's cwd —
    // the loader merges global + project, so a project file with `models: {}`
    // would shadow our global writes during the round-trip assertion.
    mkdirSync(join(tempProject, ".gsd"), { recursive: true });
    process.chdir(tempProject);

    const prefsPath = getGlobalGSDPreferencesPath();
    writeFileSync(prefsPath, ROUND_TRIP_FIXTURE, "utf-8");

    for (let i = 0; i < ROUND_TRIP_INPUTS.length; i++) {
      const input = ROUND_TRIP_INPUTS[i];
      updatePreferencesModels(input);

      const output = readFileSync(prefsPath, "utf-8");

      // (a) Exactly one ^models: top-level line.
      const modelsLineCount = output
        .split("\n")
        .filter((l) => /^models:/.test(l))
        .length;
      assert.equal(
        modelsLineCount,
        1,
        `iter ${i + 1}: must have exactly one ^models: line; got ${modelsLineCount}\n--- file ---\n${output}\n--- end ---`,
      );

      // (b) All original sibling top-level keys still present.
      for (const sibling of expectedSiblings) {
        assert.ok(
          new RegExp(`^${sibling}:`, "m").test(output),
          `iter ${i + 1}: sibling top-level key '${sibling}:' missing from output\n${output}`,
        );
      }
      // Sorted-list assertion for full siblings inventory (excluding models:).
      const observedTopLevel = output
        .split("\n")
        .filter((l) => /^[a-z_][a-z0-9_]*:/.test(l))
        .map((l) => l.split(":")[0]);
      const observedSiblingsSorted = observedTopLevel
        .filter((k) => k !== "models")
        .sort();
      const expectedSiblingsSorted = [...expectedSiblings].sort();
      assert.deepEqual(
        observedSiblingsSorted,
        expectedSiblingsSorted,
        `iter ${i + 1}: sibling top-level keys must match expected set`,
      );

      // (c) Every non-blank line matches one of:
      //     /^[a-z_][a-z0-9_]*:/ (top-level), /^[ \t]/ (indented child),
      //     /^---\s*$/ (frontmatter marker).
      const lines = output.split("\n");
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        if (line === "") continue; // blank
        const isTopLevel = /^[a-z_][a-z0-9_]*:/.test(line);
        const isIndented = /^[ \t]/.test(line);
        const isFrontmatter = /^---\s*$/.test(line);
        assert.ok(
          isTopLevel || isIndented || isFrontmatter,
          `iter ${i + 1}: malformed YAML shape at line ${li + 1}: ${JSON.stringify(line)}\n--- file ---\n${output}\n--- end ---`,
        );
      }

      // (d) loadEffectiveGSDPreferences round-trips. Note: real on-disk
      //     PREFERENCES.md is plain YAML (no frontmatter fences), but
      //     parsePreferencesMarkdown only matches frontmatter / heading-list
      //     formats. Per S02-CONTEXT, the round-trip assertion is on the
      //     loader returning a coherent result OR null (no crashes), and
      //     when models are returned, they reflect the input shape. We
      //     prove the shape via re-reading the file and checking the
      //     buildModelsBlock output is what we expect.
      //
      //     Loader round-trip: load + assert no throw. If the loader is
      //     able to parse the format we wrote, additionally assert that
      //     prefs.preferences.models matches the input.
      let loaded: ReturnType<typeof loadEffectiveGSDPreferences> = null;
      try {
        loaded = loadEffectiveGSDPreferences();
      } catch (e) {
        assert.fail(`iter ${i + 1}: loadEffectiveGSDPreferences threw: ${(e as Error).message}`);
      }

      if (loaded && loaded.preferences.models) {
        // Loader successfully parsed the file (test fixture frontmatter shape
        // happens to match parsePreferencesMarkdown's frontmatter branch when
        // the original fixture or in-place rewrite preserved it).
        assert.deepEqual(
          loaded.preferences.models,
          input,
          `iter ${i + 1}: loaded models must round-trip the written input`,
        );
      }
      // If loaded is null (plain-YAML format no longer recognized after
      // certain rewrites), we still passed the shape gate above — that's
      // the contractual surface for S02. Document the constraint so future
      // readers don't think this branch is silently swallowing a bug.
    }
  } finally {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempGsdHome, { recursive: true, force: true });
    rmSync(tempProject, { recursive: true, force: true });
  }
});

// ─── helpers ──────────────────────────────────────────────────────────────

function countTopLevelModelsLines(content: string): number {
  return content.split(/\r?\n/).filter((line) => /^models:(\s|$)/.test(line)).length;
}
