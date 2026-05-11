/**
 * state-dead-branch.test.ts — M003/S05/T04 (D004 HARDENING per D011/MEM044)
 *
 * Bug 4 (state.ts:269-270): inside `getActiveMilestoneId`'s filesystem-fallback
 * loop, both arms of the final conditional returned `mid`:
 *
 *     if (!isMilestoneComplete(roadmap)) return mid;
 *     return mid;
 *
 * The branch is dead — output is identical regardless of `isMilestoneComplete`.
 * Fix: drop the `if`, leaving the unconditional `return mid;`.
 *
 * D011 classification: HARDENING (no observable bug to reproduce — the dead
 * branch produced the same value as the unconditional return).
 *
 * R017 caveat: the public surface (`getActiveMilestoneId`) cannot distinguish
 * pre-fix from post-fix because both shapes return identical outputs across
 * every input. Behavioral coverage relies on the MEM060 source-guard subtest
 * (4B) — pair the input-matrix equivalence test (4A) with the source-guard so
 * the regression form (re-introducing the dead `if`) red-greens cleanly.
 *
 * Sub-case 4A — input-matrix behavior equivalence: build a matrix of inputs
 * exercising the filesystem-fallback path and assert post-fix output matches a
 * reference reimplementation of the pre-fix loop body.
 *
 * Sub-case 4B — MEM060 source-guard: read state.ts from disk and assert it
 * does NOT contain the literal `if (!isMilestoneComplete(roadmap)) return mid;`
 * and DOES contain the unconditional `return mid;` at the loop tail.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getActiveMilestoneId, invalidateStateCache, isMilestoneComplete } from "../state.ts";
import { clearPathCache } from "../paths.ts";
import { closeDatabase } from "../gsd-db.ts";
import { parseRoadmap } from "../parsers-legacy.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// dist-test/src/resources/extensions/gsd/tests/<file>.js → repo source state.ts
const SOURCE_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "src",
  "resources",
  "extensions",
  "gsd",
  "state.ts",
);

// Allow the markdown-derive fallback path that this test exercises.
process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK = "1";

interface Fixture {
  /** Human label used in assert messages. */
  label: string;
  /** Roadmap markdown (or null to omit ROADMAP). */
  roadmap: string | null;
  /** Summary markdown (or null to omit SUMMARY). */
  summary: string | null;
  /** Whether to also write a CONTEXT — flips the ghost predicate. */
  withContext: boolean;
  /** Whether to mark the milestone parked (PARKED.md present). */
  parked: boolean;
}

function clearCaches(): void {
  clearPathCache();
  invalidateStateCache();
}

function ensureDbClosed(): void {
  // closeDatabase() ensures no ambient DB connection routes us through the
  // DB-first arm of getActiveMilestoneId. Tests must exercise the filesystem
  // fallback path that contains the dead branch.
  try { closeDatabase(); } catch { /* ignore */ }
}

function buildBase(milestones: Array<{ mid: string; fx: Fixture }>): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-state-deadbranch-")));
  for (const { mid, fx } of milestones) {
    const mDir = join(base, ".gsd", "milestones", mid);
    mkdirSync(mDir, { recursive: true });
    if (fx.roadmap !== null) {
      writeFileSync(join(mDir, `${mid}-ROADMAP.md`), fx.roadmap, "utf-8");
    }
    if (fx.summary !== null) {
      writeFileSync(join(mDir, `${mid}-SUMMARY.md`), fx.summary, "utf-8");
    }
    if (fx.withContext) {
      writeFileSync(join(mDir, `${mid}-CONTEXT.md`), `# ${mid} Context\n`, "utf-8");
    }
    if (fx.parked) {
      writeFileSync(join(mDir, `${mid}-PARKED.md`), "Parked for testing.\n", "utf-8");
    }
  }
  return base;
}

function roadmapWith(mid: string, allDone: boolean): string {
  const cb = allDone ? "x" : " ";
  return [
    `# ${mid}: Test Milestone`,
    "",
    "## Vision",
    "Behavior-preserving check.",
    "",
    "## Slices",
    `- [${cb}] **S01: Setup** \`risk:low\` \`depends:[]\``,
    "  - After this: setup complete.",
  ].join("\n");
}

function summaryWith(mid: string, terminal: boolean): string {
  // Terminal = unknown classification (handwritten/legacy, treated terminal).
  // Non-terminal = explicit failure verdict via frontmatter status.
  if (terminal) {
    return `---\nid: ${mid}\n---\n\n# ${mid} — Complete\n`;
  }
  return `---\nid: ${mid}\nstatus: failed\n---\n\n# ${mid} — Failed\n`;
}

/**
 * Pre-fix loop body, inline-replicated. Reproduces only the conditional under
 * test (the dead `if` at line 269). Routes through the SAME `parseRoadmap` +
 * `isMilestoneComplete` pair the production code uses, so any equivalence
 * between this loop and the production loop with the dead `if` reintroduced
 * would be exhaustive — the only observable difference vs production is the
 * presence of the dead `if`, and `isMilestoneComplete(roadmap)` is the only
 * value it gates on.
 */
async function preFixActiveMilestoneId(
  base: string,
  fixtures: Array<{ mid: string; fx: Fixture }>,
): Promise<string | null> {
  for (const { mid } of fixtures) {
    const mDir = join(base, ".gsd", "milestones", mid);
    const parkedPath = join(mDir, `${mid}-PARKED.md`);
    if (existsSync(parkedPath)) continue;

    const roadmapPath = join(mDir, `${mid}-ROADMAP.md`);
    const summaryPath = join(mDir, `${mid}-SUMMARY.md`);
    const contextPath = join(mDir, `${mid}-CONTEXT.md`);
    const draftPath = join(mDir, `${mid}-CONTEXT-DRAFT.md`);

    const roadmapContent = existsSync(roadmapPath) ? readFileSync(roadmapPath, "utf-8") : null;

    // Mirror isTerminalMilestoneSummaryContent: failure ⇒ NOT terminal.
    const summaryIsTerminal = (() => {
      if (!existsSync(summaryPath)) return false;
      const sc = readFileSync(summaryPath, "utf-8");
      const failureSignal = /(?:^|\n)\s*#\s*BLOCKER\b/i.test(sc)
        || /auto-mode recovery failed/i.test(sc)
        || /verification\s+failed/i.test(sc);
      const fmFailure = /^---[\s\S]*?\bstatus:\s*(failed|failure|active|pending|blocked|incomplete)\b[\s\S]*?---/i.test(sc);
      return !(failureSignal || fmFailure);
    })();

    if (!roadmapContent) {
      if (existsSync(summaryPath) && summaryIsTerminal) continue;
      // Mirror isGhostMilestone fallback (no DB row, no worktree, no content files).
      const ghost = !existsSync(contextPath) && !existsSync(draftPath) && !existsSync(roadmapPath) && !existsSync(summaryPath);
      if (ghost) continue;
      return mid;
    }

    const roadmap = parseRoadmap(roadmapContent);
    if (existsSync(summaryPath) && summaryIsTerminal) continue;

    // PRE-FIX dead branch — preserved deliberately for equivalence proof.
    if (!isMilestoneComplete(roadmap)) return mid;
    return mid;
  }
  return null;
}

test("Sub-case 4A: input-matrix behavior equivalence — post-fix output matches pre-fix loop body for the filesystem fallback path", async () => {
  // Each row is a self-contained fixture: a single base dir with one or more
  // milestones in declared order. We assert that getActiveMilestoneId(base)
  // equals the inline pre-fix replicated walk over the same fixtures.
  const matrix: Array<{ name: string; rows: Array<{ mid: string; fx: Fixture }>; }> = [
    {
      name: "(i) incomplete roadmap",
      rows: [{ mid: "M001", fx: { label: "incomplete-roadmap", roadmap: roadmapWith("M001", false), summary: null, withContext: true, parked: false } }],
    },
    {
      name: "(ii) complete roadmap WITHOUT terminal summary",
      rows: [{ mid: "M001", fx: { label: "complete-no-summary", roadmap: roadmapWith("M001", true), summary: null, withContext: true, parked: false } }],
    },
    {
      name: "(iii) complete roadmap WITH terminal summary",
      rows: [
        { mid: "M001", fx: { label: "complete-terminal-summary", roadmap: roadmapWith("M001", true), summary: summaryWith("M001", true), withContext: true, parked: false } },
        { mid: "M002", fx: { label: "incomplete-roadmap-trailing", roadmap: roadmapWith("M002", false), summary: null, withContext: true, parked: false } },
      ],
    },
    {
      name: "(iii-b) complete roadmap WITH non-terminal (failure) summary",
      rows: [{ mid: "M001", fx: { label: "complete-failure-summary", roadmap: roadmapWith("M001", true), summary: summaryWith("M001", false), withContext: true, parked: false } }],
    },
    {
      name: "(iv) ghost milestone (no roadmap/summary/context/draft)",
      rows: [
        { mid: "M001", fx: { label: "ghost", roadmap: null, summary: null, withContext: false, parked: false } },
        { mid: "M002", fx: { label: "real-trailing", roadmap: roadmapWith("M002", false), summary: null, withContext: true, parked: false } },
      ],
    },
    {
      name: "(v) parked milestone — must be skipped",
      rows: [
        { mid: "M001", fx: { label: "parked", roadmap: roadmapWith("M001", false), summary: null, withContext: true, parked: true } },
        { mid: "M002", fx: { label: "real-trailing", roadmap: roadmapWith("M002", false), summary: null, withContext: true, parked: false } },
      ],
    },
    {
      name: "(vi) only one milestone, parked — must return null",
      rows: [{ mid: "M001", fx: { label: "lone-parked", roadmap: roadmapWith("M001", false), summary: null, withContext: true, parked: true } }],
    },
    {
      name: "(vii) all complete with terminal summaries — must return null",
      rows: [
        { mid: "M001", fx: { label: "done-001", roadmap: roadmapWith("M001", true), summary: summaryWith("M001", true), withContext: true, parked: false } },
        { mid: "M002", fx: { label: "done-002", roadmap: roadmapWith("M002", true), summary: summaryWith("M002", true), withContext: true, parked: false } },
      ],
    },
  ];

  const cleanups: string[] = [];
  try {
    for (const row of matrix) {
      ensureDbClosed();
      clearCaches();
      const base = buildBase(row.rows);
      cleanups.push(base);
      ensureDbClosed();
      clearCaches();
      const post = await getActiveMilestoneId(base);
      const pre = await preFixActiveMilestoneId(base, row.rows);
      assert.equal(post, pre, `behavior equivalence failed for ${row.name}: post=${post} pre=${pre}`);
    }
  } finally {
    for (const base of cleanups) {
      try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    ensureDbClosed();
    clearCaches();
  }
});

test("Sub-case 4B: MEM060 source-guard — dead `if (!isMilestoneComplete(roadmap)) return mid;` removed; unconditional `return mid;` retained at loop tail", () => {
  const source = readFileSync(SOURCE_PATH, "utf-8");

  // Negative guard: regression form must not appear anywhere in state.ts.
  assert.ok(
    !/if\s*\(\s*!\s*isMilestoneComplete\s*\(\s*roadmap\s*\)\s*\)\s*return\s+mid\s*;/.test(source),
    "regression: `if (!isMilestoneComplete(roadmap)) return mid;` reintroduces the M003/S05/T04 dead branch",
  );

  // Positive guard: locate the post-fix shape — the unconditional `return mid;`
  // immediately following the terminal-summary `continue;` line in
  // getActiveMilestoneId's filesystem fallback loop, terminating in `return null;`.
  const tailMatch = source.match(
    /isTerminalMilestoneSummaryFile\(summaryFile,\s*loadFile\)\)\s*continue;\s*\n\s*return\s+mid;\s*\n\s*\}\s*\n\s*return\s+null;\s*\n\s*\}/,
  );
  assert.ok(
    tailMatch,
    "expected unconditional `return mid;` immediately after the terminal-summary `continue;` at the tail of getActiveMilestoneId's filesystem fallback loop",
  );
});
