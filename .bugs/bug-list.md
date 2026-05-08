<<<<<<< HEAD
# Bug List

20 parallel review agents covered the entire directory tree (subdirectories excluded only for test scaffolding, prompts/templates, and fixture data). Findings below are aggregated and tiered. Each item carries `file:line` so you can jump to it.

---

## CRITICAL (4)

| # | File:Line | Issue |
|---|-----------|-------|
| 1 | `gsd-db.ts:2759-2769` | `restoreManifest()` deletes parent slices/tasks/milestones without first removing `quality_gates`, `slice_dependencies`, `replan_history`, `assessments`, `milestone_commit_attributions`. With `PRAGMA foreign_keys = ON` (enabled in `initSchema`) the DELETE will throw and roll back the entire restore. Mirror `clearEngineHierarchy()` ordering. |
| 2 | `db-migration-steps.ts:435-456` | v22 migration creates `quality_gates_new` without `IF NOT EXISTS`; a partial-then-retry run hits "table already exists". Add `DROP TABLE IF EXISTS quality_gates_new` or `IF NOT EXISTS`. |
| 3 | `parallel-merge.ts:48` & `parallel-monitor-overlay.ts:135,175` | SQL injection via worktree directory names interpolated into `sqlite3` CLI queries. Filename allowlist is weak (`startsWith("M")`). Validate against `/^M\d{3}[A-Z0-9-]*$/` or use bound parameters. |
| 4 | `preferences-models.ts:339` | `updatePreferencesModels` regex `^models:[\s\S]*?(?=\n[a-z_]|\n*$)` collapses to just the literal `"models:"` (lookahead matches at first newline). Every `/gsd model …` write injects a duplicate `models` block instead of replacing — corrupting YAML. Combined with non-atomic `writeFileSync` on line 346, a SIGINT mid-write wipes all preferences. |

---

## HIGH (selected — ~70 total across all subsystems)

### Auto-mode core (`auto*.ts`, `auto/`)

- `auto.ts:1859` — `getMilestone(meta.milestoneId)` reads from possibly-wrong project DB before retry path triggers.
- `auto-dispatch.ts:280-285,305-311` — `setRewriteCount`/`incrementUatCount` non-atomic; SIGKILL mid-write resets circuit breakers, defeating loop-prevention.
- `auto-dispatch.ts:670-683` — Project-research in-flight marker permanently blocks dispatch on SIGTERM mid-prompt-build (no recovery).
- `auto-recovery.ts:961-998` — `writeBlockerPlaceholder` mutates file → DB → event log → placeholder slice with no transaction; partial failure is unrecoverable.
- `auto-verification.ts:334` vs `auto-post-unit.ts:1066` — Two retry counters use different key schemas (`s.currentUnit.id` vs `${type}:${id}`), so retries from one don't influence the other.
- `auto-post-unit.ts:691-764` — `sliceMergeStopped` flag set after `await stopAuto`; swallowed `runSafely` error allows triage to run on a conflicted main checkout.
- `auto-worktree.ts:2167-2186` — Throw path (nothing-to-commit safety check) skips `restoreShelter()` and stash-pop; sheltered milestone dirs and stash are stranded.
- `auto-worktree.ts:2074-2076` — `nativeCommit` returning `null` is treated as "nothing to commit" but the worktree is destroyed regardless → data loss for `.gsd/`-only commits.
- `auto-artifact-paths.ts:53-116` — `parseUnitId` outputs joined into paths via non-null asserts (`sid!`). Operator/queue-controlled unit IDs containing `..` could escape milestone dir.
- `auto-dashboard.ts:464-466,530-548` — Cross-project widget-mode pref leak: first project loaded wins; subsequent toggles write to the wrong project's preferences file.
- `auto-model-selection.ts:373-378` — Unknown `previousTier` strings silently fall through to lower-tier model on retry.
- `auto-start.ts:836-839` — Windows-only regex bug in `isUnderGsdWorktrees`; on Windows the symlinked layout is never detected, causing re-entry attempts.
- `auto/loop.ts:373-390,825-834` — `ModelPolicyDispatchBlockedError` skips dispatch-ledger settle, leaving rows stuck in `running`; custom-engine path bypasses `openDispatchClaim` entirely (no fencing).
- `auto/run-unit.ts:79-105` — `_setSessionSwitchInFlight(true)` set before `try`; synchronous `newSession()` throws leak the flag forever, permanently dropping `resolveAgentEnd`.
- `auto/run-unit.ts:154-167` — Order: clear flag → install resolver. Fresh `agent_end` events arriving in-between are dropped.
- `auto/phases.ts:1832-1839,2019-2030` — `s.checkpointSha` never cleaned up if `runUnit` throws (git ref leak); `s.currentUnit.startedAt` race after `await runUnit`.

### DB

- `gsd-db.ts:1591-1605` — `setMilestoneQueueOrder` issues raw `BEGIN IMMEDIATE` outside `_transactionRunner`; nested call corrupts depth tracker.
- `gsd-db.ts:702-715` — `vacuumDatabase`/`checkpointDatabase` don't gate on `isInTransaction()`.
- `gsd-db.ts:1793-1794` — `ATTACH DATABASE '${worktreeDbPath}'` raw string interpolation (allowlist regex doesn't block backslashes); use `ATTACH DATABASE ?`.
- `gsd-db.ts:438-512` — `openDatabaseByWorkspace` snapshot/restore leaves a stale cached entry on open-failure.
- `db/unit-dispatches.ts:269-271` — `markFailed` treats `retryAfterMs === 0` as "no retry" instead of immediate retry.

### Commands

- `commands-pr-branch.ts:213` — Cherry-pick conflict path leaves user on PR branch instead of original; checkout failure throws into outer catch with confusing message.
- `commands-bootstrap.ts:38` — Boot-time pref write missing `mkdirSync`; can ENOENT-crash startup.
- `commands-bootstrap.ts:30` & `commands-cmux.ts:128-137` — Cmux on clobbers user's per-feature settings; bootstrap re-asserts `enabled = true` on every boot regardless of user intent.
- `commands-do.ts:42, 62-64` — `lower.includes(keyword)` matches mid-word; `/gsd do auto-mode the parser` matches "auto" keyword and produces `command="auto"`, `args="-mode the parser"`.
- `commands-extensions.ts:594` — `parseNpmSpecifier` quirks for malformed inputs.
- `commands-handlers.ts:39-47` — `isBunInstall` may misfire on path traversal via `BUN_INSTALL` env.
- `commands-debug.ts:97` — Uses `process.cwd()` instead of `currentDirectoryRoot()`; inconsistent with rest of codebase, breaks subdir invocation.
- `commands-maintenance.ts:266-282` — `handleSkip` regex too narrow; non-atomic write to `completed-units.json` races with concurrent skip.
- `commands-memory.ts:392-413` — `handleImport` not transactional; partial import leaves N memories with 0 relations.
- `commands-memory.ts:398-405` — Import drops original memory IDs, breaking the entire relation graph silently.
- `commands/handlers/workflow.ts:539` — Race on `headless-context.md` consumption between concurrent TUI sessions.
- `commands-prefs-wizard.ts:1665` — `yamlSafeString` early-returns `String(val)` for non-strings; arrays become `"1,2"`, objects `"[object Object]"`.

### Workflow / Worktree

- `workflow-events.ts:41-59` — `appendEvent` not file-locked; races with `compactMilestoneEvents` truncation and reconcile rewrite. Events appended after `readEvents()` and before `atomicWriteSync()` are silently dropped.
- `workflow-install.ts:194-200` — Size cap checked AFTER full body buffered (OOM vector via malicious server).
- `workflow-projections.ts:438-451` — `regenerateIfMissing` switch missing `default:`; `filePath` may be undefined for new fileTypes → `existsSync(undefined)` throws.
- `workflow-reconcile.ts:485` — Recursive retry on log growth has no bound; concurrent `appendEvent` + reconcile can spin forever.
- `workflow-reconcile.ts:614-670,119-128` — `resolveConflict` recurses into reconcile, double-replays events; `record_verification` insert has no idempotency key → duplicate evidence rows.
- `custom-workflow-engine.ts:115-218` — Step marked active on disk before dispatch; if `injectContext` throws after `markStepActive`/`writeGraph`, no rollback.
- `worktree-command.ts:309` — User-supplied name validation regex permits leading `-` (e.g. `--upload-pack=...`); potential git option injection.
- `worktree-command.ts:142` — Case-insensitive name collision on macOS/Windows triggers `GSD_STALE_STATE` instead of graceful switch.
- `worktree-manager.ts:561-606` — `removeWorktree` runs `git submodule status` → `git add -A` → `git commit` chain unsynchronized in a contested worktree (data corruption risk).
- `worktree-manager.ts:651-659` — Force-`rmSync(wtInternalDir)` uses naive `join(basePath, ".git", "worktrees", name)`; doesn't handle worktree-pointer-file `.git`.
- `worktree-resolver.ts:208-282` — `enterMilestone` lease leaked on worktree-create failure (no release in catch).
- `worktree-root.ts:79-95` — `resolveProjectRootFromPath` falls back to returning the symlinked external state path on git-file resolution failure → writes/reads land in wrong place.
- `worktree-session-state.ts:1-3,18` — Module-global `originalCwd` with no synchronization; CRLF/separator regex is fragile and ignores symlinked external layout.

### State / locks / session

- `session-lock.ts:308-316,349-372` — TOCTOU: stale-lock `rmSync(lockDir)` after PID-dead check can stomp a fresh owner that won the race in between.
- `session-status-io.ts:81-88` — `isPidAlive` returns `false` on EPERM; on multi-user hosts (CI), foreign-uid sessions are treated as stale and wiped.
- `state.ts:269-270` — Dead branch: both arms return `mid`. Roadmap-completeness no longer matters at that decision point (likely refactor leftover).

### Verification / gates / safety

- `verification-gate.ts:147,219` — `sanitizeCommand` only applied at discovery time for `taskPlanVerify`; preference-sourced commands skip the injection check entirely.
- `verification-gate.ts:267` — `spawnSync` no `maxBuffer`; chatty tests overrun 1MB default and report exit 127 ("command not found").
- `custom-verification.ts:161` — Dangerous-pattern denylist is security theater (`/\$\(||;\s*(rm|curl|...)\b/`); doesn't catch `&& rm`, `| rm`, redirections, or arbitrary commands not in tiny denylist.
- `bootstrap/write-gate.ts:66` — `BASH_READ_ONLY_RE` not end-anchored; `mkdir -p .gsd && rm -rf /tmp/x`, `cat /etc/passwd ; rm -rf /` all match the safe-command regex and are allowed in queue mode.
- `pre-execution-checks.ts:215` — Spawn-error in `checkPackageOnNpm` returns `exists:true`; missing-npm CI silently passes every package check.

### Doctor

- `doctor-environment.ts:296` — Shell injection: `df -k "${basePath}"` interpolates `basePath` unescaped.
- `doctor-environment.ts:478,507` — `npm run build`/`test` use 5s timeout; realistic builds exceed → consistent false-positive failures.
- `doctor-environment.ts:114` — Node version regex `>=?` accepts `>` as `>=`, ignores compound ranges; produces false-negatives for `<=18`.
- `doctor-runtime-checks.ts:88-92` — `isLockProcessAlive` called with synthetic `LockData`; PID-only check is wrong on systems with PID wrap.
- `doctor-runtime-checks.ts:241` — JSON-parse failure on UAT counter triggers file deletion (mistaken for retry exhaustion).
- `doctor-proactive.ts:240` — `.git/MERGE_HEAD` check is blind inside worktrees because `.git` is a file, not a directory. Pre-dispatch merge-state corruption never detected in worktree-mode auto runs.
- `doctor-providers.ts:102` — Provider inference misses `deepseek-`, `qwen-`, `llama-3-` etc.; doctor reports "ok" while no key is configured.
- `doctor.ts:464` — Title sanitizer doesn't normalize `/`; auto-fix loops forever on titles with forward slashes.

### Detection / triage / classifier

- `complexity-classifier.ts:203,226` — Path missing `"milestones"` segment; `RESEARCH.md` and task plan reads silently always fail. Phase 4 introspection is effectively disabled.
- `error-classifier.ts:51,62,67` — Unanchored `\b500\b`/`\b429\b`; substrings like `"5000ms"` get classified as transient server, network errors get rate-limit classification with 60s wait.
- `detection.ts:683,742-748` — Module-level `SUPPORTED_PLATFORMS_RE` with `g` flag; cross-file `lastIndex` leak from prior iteration.
- `triage-resolution.ts:141-157` — `executeBacktrack` with bare `M001` in user prompt vs current `M001-abc123` re-targets the same milestone.

### Memory / context / utils

- `memory-store.ts:639` — `MEM###` 3-digit padding breaks lexicographic sort once `seq` exceeds 999.
- `memory-store.ts:377` — String-substituted `activeClause` in FTS SQL is a SQL injection foothold for any future caller.
- `key-manager.ts:399-409,719-726` — `auth.remove()` then re-add survivors loop. Crash mid-loop loses ALL credentials for the provider with no recovery.
- `paths.ts:539-548` — Walk-up loop terminates immediately after one parent because `basePath` is mutated and used as termination condition.
- `undo.ts:54` — `unitId.replace(/-/g, "/")` corrupts unit IDs that legitimately contain hyphens.
- `forensics.ts:1319` — Anthropic API key redaction misses `sk-ant-...` (regex stops at first hyphen).

### Visualizer / dashboard / notifications

- `visualizer-overlay.ts:96,567` — Mouse tracking enabled globally; no SIGINT handler → terminal left in mouse-tracking mode on abnormal exit.
- `notification-store.ts:317-318` — Spinning busy-wait on lock contention pins a CPU core.
- `notifications.ts:122-124` — AppleScript escape only handles backslash + double quote; doesn't strip Unicode line separators.
- `markdown-renderer.ts:493-567` — Regexes built from unescaped slice/task IDs (`new RegExp(...sid:...)` without `escapeRegExp`).
- `export-html.ts:953-957` — `e.resolution`, `e.rationale` not HTML-escaped → XSS in generated reports.

### Slice / parallel / guided-flow

- `slice-parallel-orchestrator.ts:773-776` — Wrong NDJSON path for cost extraction; `worker.cost`/`sliceState.totalCost` stay at 0 forever, defeating budget enforcement.
- `slice-cadence.ts:185,257,282,343` — `process.chdir` is process-global; concurrent merges corrupt `cwd` for everything else in the process.
- `slice-parallel-conflict.ts:24-36` — File-extraction regex requires leading non-word char; misses paths at line start. Empty extraction silently allowed (contradicts "conservative" comment).
- `guided-flow.ts:536-725,919-989` — `_getPendingAutoStart()` returns `null` with >1 entries; multi-project sessions break recovery silently.
=======
# Bug List Annotations (M001/S01, M001/S02, M001/S03, M001/S04, M001/S05)

This file is a **worktree-local annotation** for the canonical bug list at
`.bugs/bug-list.md` in the project root. The S01 worktree-isolation guard
(`git.isolation: worktree`) blocks writes to the canonical file from inside the
M001 worktree, so the fix-confirmation notes below are recorded here. The merge
back to main should be followed up by manually editing the canonical rows, or by
relaxing the guard for `.bugs/` (see follow-up note in `T04-SUMMARY.md` and
`.gsd/milestones/M001/slices/S05/forward-note.md`).

## Forward Note (post-merge)

After M001 merges to main, manually annotate the canonical
`.bugs/bug-list.md` rows for **CRITICAL #3** and **CRITICAL #4** with their
respective `[FIXED M001/S01]` and `[FIXED M001/S02]` tags. The worktree-isolation
guard re-blocks these edits on every subsequent worktree, so the canonical file
must be touched from a non-worktree checkout (or with
`GSD_DISABLE_WORKTREE_WRITE_GUARD=1` set during a maintenance commit).

S03, S04, and S05 forward-notes (in their respective slice directories) describe
the additional canonical-file annotations to apply post-merge for CRITICAL #1,
CRITICAL #2, and the five S05 HIGH DB-integrity bugs.

## CRITICAL #3 — sqlite3 CLI SQL injection via worktree directory names

| Field | Value |
|-------|-------|
| Original location | `parallel-merge.ts:48` & `parallel-monitor-overlay.ts:135,175` |
| Issue | SQL injection via worktree directory names interpolated into sqlite3 CLI queries. Filename allowlist was weak (`startsWith("M")`). |
| Status | **[FIXED M001/S01]** |
| Validators | `assertMilestoneId` / `assertSliceId` / `assertTaskId` / `assertWorktreePath` in `src/resources/extensions/gsd/milestone-ids.ts` |
| Boundary wrapper | `runSqliteCli` in `src/resources/extensions/gsd/parallel-sqlite-cli.ts` (calls `assertMilestoneId(args.mid, 'runSqliteCli')` before composing SQL) |
| Reproduce-and-prevent test | `src/resources/extensions/gsd/tests/parallel-merge-rejects-malicious-worktree-name.test.ts` |
| Fix evidence | `.gsd/milestones/M001/slices/S01/tasks/T04-SUMMARY.md` (D004 gate) |

## CRITICAL #4 — preferences-models.ts:339,346 — broken regex + non-atomic write

| Field | Value |
|-------|-------|
| Original location | `src/resources/extensions/gsd/preferences-models.ts:339` (regex), `:346` (non-atomic `writeFileSync`) |
| Issue | `updatePreferencesModels` regex `^models:[\s\S]*?(?=\n[a-z_]\|\n*$)` collapses to just the literal `models:` (lookahead matches at first newline). Every `/gsd model …` write injects a duplicate `models:` block instead of replacing — corrupting YAML. Combined with non-atomic `writeFileSync`, a SIGINT mid-write wipes all preferences. |
| Status | **[FIXED M001/S02]** |
| Fix (regex) | Replaced `String.replace(regex, …)` with line-walker `replaceOrAppendModelsBlock` that finds the `^models:` line, walks forward consuming nested-indented continuation lines until the next top-level key (or EOF), and self-heals duplicate `models:` blocks transparently. Pure function; only `replaceOrAppendModelsBlock` is exported (the `buildModelsBlock` helper stays private). |
| Fix (atomic write) | `updatePreferencesModels` now routes through `atomicWriteSync` (already used elsewhere in the codebase). On rename failure (e.g. ENOSPC), the original `~/.gsd/PREFERENCES.md` is left intact and the wrapped error from `buildAtomicWriteError` includes `{path, attempts, code}` context. |
| Reproduce-and-prevent test | `src/resources/extensions/gsd/tests/preferences-models-regex-and-atomic-write.test.ts` (9 branch-coverage subtests + 1 rename-failure seam test + 1 five-iteration round-trip behavioral test). D004 gate verified: 6 fails pre-fix → 11/11 pass post-fix. |
| Fix evidence | `.gsd/milestones/M001/slices/S02/tasks/T01-SUMMARY.md`, `T02-SUMMARY.md`, `T03-SUMMARY.md` |

## CRITICAL #1 — gsd-db.ts:2759-2770 — restoreManifest FK violation under PRAGMA foreign_keys=ON

| Field | Value |
|-------|-------|
| Original location | `src/resources/extensions/gsd/gsd-db.ts:2759-2770` (`restoreManifest`) |
| Issue | `restoreManifest()` cleared `milestones`, `slices`, `tasks`, `verification_evidence` directly, leaving FK-bearing children (`quality_gates`, `slice_dependencies`, `replan_history`, `assessments`, `milestone_commit_attributions`, `requirement_coverage`, `gate_results`) untouched. With `PRAGMA foreign_keys = ON` (set in `initSchema`), the parent DELETE throws `SQLITE_CONSTRAINT: FOREIGN KEY constraint failed` and the entire restore rolls back, leaving `bootstrapFromManifest` consumers without recovery. |
| Status | **[FIXED M001/S03]** |
| Fix | Extracted private `clearHierarchyTablesInOrder(db: DbAdapter)` covering all 10 hierarchy tables in FK-safe order (children → parents). Rewired both `restoreManifest` and `clearEngineHierarchy` through the helper under existing `transaction()` wrappers — single source of truth for hierarchy DELETE order. Helper does NOT open its own transaction (caller wraps; honors `_transactionRunner` no-nested-BEGIN invariant). |
| Reproduce-and-prevent test | `src/resources/extensions/gsd/tests/restore-manifest-fk-violation-rolls-back.test.ts` — exercises `bootstrapFromManifest` against a non-empty seeded hierarchy with `PRAGMA foreign_keys=ON`. D004 gate captured: pre-fix throws `SQLITE_CONSTRAINT: FOREIGN KEY constraint failed`; post-fix passes (5/5). |
| Order verification | `src/resources/extensions/gsd/tests/clear-hierarchy-tables-in-order.test.ts` — recording-fake DbAdapter asserts exact 10-table DELETE order via `assert.deepEqual` on full captured-SQL array (reorder/omit/add all fail). |
| Fix evidence | `.gsd/milestones/M001/slices/S03/tasks/T01-SUMMARY.md`, `T02-SUMMARY.md`, `T03-SUMMARY.md` |

## HIGH (S05) — `gsd-db.ts:1591-1605` — setMilestoneQueueOrder raw `BEGIN IMMEDIATE` outside `_transactionRunner`

| Field | Value |
|-------|-------|
| Original location | `src/resources/extensions/gsd/gsd-db.ts:1591-1605` (`setMilestoneQueueOrder`) — post-fix body at lines 1709-1726 |
| Issue | Raw `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` issued directly on `currentDb` outside the depth-tracked `_transactionRunner`. Nested invocation (caller wrapping `setMilestoneQueueOrder` in `transaction(() => …)`) triggers SQLite's `cannot start a transaction within a transaction` and corrupts the runner's depth tracker. |
| Status | **[FIXED M001/S05]** |
| Fix | Replaced the raw try/begin/commit/rollback block with a single `transaction(() => …)` call routing both UPDATEs through `_transactionRunner`. Depth tracker elides the inner BEGIN/COMMIT when already inside an outer transaction. |
| Reproduce-and-prevent test | `src/resources/extensions/gsd/tests/set-milestone-queue-order-uses-transaction-runner.test.ts` (D004 RED/GREEN captured at `.gsd/milestones/M001/slices/S05/tasks/T01-prefix-failure.txt` / `T01-postfix-pass.txt`) |
| Fix evidence | `.gsd/milestones/M001/slices/S05/tasks/T01-SUMMARY.md` |

## HIGH (S05) — `gsd-db.ts:702-715` — vacuumDatabase / checkpointDatabase missing `isInTransaction()` gate

| Field | Value |
|-------|-------|
| Original location | `src/resources/extensions/gsd/gsd-db.ts:702-715` (`vacuumDatabase`, `checkpointDatabase`) — post-fix bodies at lines 765-797 |
| Issue | `VACUUM` and `PRAGMA wal_checkpoint(TRUNCATE)` are destructive whole-DB operations that SQLite forbids inside a transaction; running them inside an `isInTransaction()` window throws cryptic `cannot VACUUM from within a transaction` and rolls back the enclosing tx. |
| Status | **[FIXED M001/S05]** |
| Fix | Added `if (isInTransaction()) { logWarning('db', 'VACUUM skipped: inside transaction'); return; }` early-return at the top of both functions (skip-with-warning, not throw) so wrappers that opportunistically call vacuum/checkpoint inside a tx silently no-op rather than blowing up the outer transaction. |
| Reproduce-and-prevent test | `src/resources/extensions/gsd/tests/vacuum-checkpoint-skips-inside-transaction.test.ts` (D004 RED/GREEN captured at `.gsd/milestones/M001/slices/S05/tasks/T02-prefix-failure.txt` / `T02-postfix-pass.txt`) |
| Failure-visibility log | `logWarning('db', 'VACUUM skipped: inside transaction')` / `logWarning('db', 'WAL checkpoint skipped: inside transaction')` — searchable via `rg 'inside transaction' .gsd/activity/` |
| Fix evidence | `.gsd/milestones/M001/slices/S05/tasks/T02-SUMMARY.md` |

## HIGH (S05) — `gsd-db.ts:1793-1794` — ATTACH DATABASE raw template-string interpolation

| Field | Value |
|-------|-------|
| Original location | `src/resources/extensions/gsd/gsd-db.ts:1793-1794` (`ATTACH DATABASE '${worktreeDbPath}' AS wt`) — post-fix call site at lines 1836-1875 |
| Issue | Worktree DB path interpolated directly into DDL string. The pre-existing weak `[';";\x00]` regex did not block backslashes, embedded-newline-then-comment, or other path payloads; `better-sqlite3`/`node-sqlite3` cannot bind DDL parameters so `prepare('ATTACH DATABASE ? AS wt')` is not viable (MEM030). Path-shaped attacks slipped through. |
| Status | **[FIXED M001/S05]** |
| Fix | Added new `assertGsdDbPath(p, source)` exported helper at `milestone-ids.ts:272` (reuses existing `'worktree-path'` `InvalidIdKind` discriminator) that requires the path end in `<root>/.gsd/gsd.db` where `<root>` is a directory whose basename matches `MILESTONE_ID_RE`. Production call site now validates with `assertGsdDbPath(worktreeDbPath, 'attachWorktreeDb')` before string-concat ATTACH; structured `InvalidIdError` re-thrown via existing `logError('db', …)` so forensics see `{ source, attemptedId, kind }`. |
| Reproduce-and-prevent test | `src/resources/extensions/gsd/tests/attach-database-rejects-malicious-worktree-path.test.ts` — 11 assertions (validator unit + behavioral D004). Captures at `.gsd/milestones/M001/slices/S05/tasks/T03-prefix-failure.txt` / `T03-postfix-pass.txt`. |
| Fix evidence | `.gsd/milestones/M001/slices/S05/tasks/T03-SUMMARY.md` |

## HIGH (S05) — `db/unit-dispatches.ts:269-271` — markFailed treats `retryAfterMs === 0` as no-retry

| Field | Value |
|-------|-------|
| Original location | `src/resources/extensions/gsd/db/unit-dispatches.ts:269-271` (`markFailed`) — post-fix body at lines 269-274 |
| Issue | Truthy ternary (`opts.retryAfterMs ? new Date(...).toISOString() : null`) treated `retryAfterMs === 0` as "no retry" instead of "schedule immediate retry now", silently dropping immediate-retry semantics that operability code relies on. |
| Status | **[FIXED M001/S05]** |
| Fix | Replaced ternary with explicit `(typeof opts.retryAfterMs === 'number') ? ... : null` guard. Documents intent (numeric ms value) and rejects accidental string/object passes that `!= null` would silently allow. 3-line comment block tagging D004/M001/S05/T04 above the new check for forensics. |
| Reproduce-and-prevent test | `src/resources/extensions/gsd/tests/mark-failed-retry-after-ms-zero-retries-immediately.test.ts` (2-case D004 regression: immediate-retry + no-retry path). Captures at `.gsd/milestones/M001/slices/S05/tasks/T04-prefix-failure.txt` / `T04-postfix-pass.txt`. |
| Fix evidence | `.gsd/milestones/M001/slices/S05/tasks/T04-SUMMARY.md` |

## HIGH (S05) — `gsd-db.ts:438-512` — openDatabaseByWorkspace cache TOCTOU on open-failure

| Field | Value |
|-------|-------|
| Original location | `src/resources/extensions/gsd/gsd-db.ts:438-512` (`openDatabaseByWorkspace`) — post-fix body at lines 437-573 |
| Issue | Snapshot/restore around `openDatabase(key)` left a stale cached entry in `_dbCache` if the open path threw or returned `!opened`. A subsequent retry against the same workspace key would either short-circuit on the stale entry or race with a concurrent opener — both branches eventually corrupted the cache. |
| Status | **[FIXED M001/S05]** |
| Fix | Defensive `_dbCache.delete(key)` on both failure branches (`throw` and `!opened`) plus `logWarning('db', 'open-failure cache cleanup', { key })`. Widened the `else if (!opened && oldDb !== null)` guard to `else if (!opened)` with nested `if (oldDb !== null)` so cleanup fires even when there's no previous workspace to restore to. New `_setOpenDatabaseForTests(opener)` seam (mirrors S01's `_setSqliteRunnerForTests`) routes through `_activeOpenDatabase` for deterministic D005 seam-injection tests; new `_setDbCacheEntryForTests(key, entry)` helper plants stale entries in tests to simulate the concurrent-open race without spawning threads. |
| Reproduce-and-prevent test | `src/resources/extensions/gsd/tests/open-database-by-workspace-cleans-cache-on-open-failure.test.ts` — 3 sub-tests (throw branch + !opened branch with seam-planted stale entry; seam-reset smoke test). Captures at `.gsd/milestones/M001/slices/S05/tasks/T05-prefix-failure.txt` / `T05-postfix-pass.txt`. |
| Failure-visibility log | `logWarning('db', 'open-failure cache cleanup', { key })` — searchable via `rg 'open-failure cache' .gsd/activity/` |
| Fix evidence | `.gsd/milestones/M001/slices/S05/tasks/T05-SUMMARY.md` |
>>>>>>> milestone/M001
