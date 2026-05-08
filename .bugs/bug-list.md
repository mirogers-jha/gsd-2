20 parallel review agents covered the entire directory tree (subdirectories excluded only for test scaffolding, prompts/templates, and fixture data). Findings below are aggregated and tiered. Each item carries file:line so you can jump to it.

---
CRITICAL (4)

┌─────┬────────────────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  #  │                       File:Line                        │                                                                                                                                          Issue                                                                                                                                           │
├─────┼────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 1   │ gsd-db.ts:2759-2769                                    │ restoreManifest() deletes parent slices/tasks/milestones without first removing quality_gates, slice_dependencies, replan_history, assessments, milestone_commit_attributions. With PRAGMA foreign_keys = ON (enabled in initSchema) the DELETE will throw and roll back the entire      │
│     │                                                        │ restore. Mirror clearEngineHierarchy() ordering.                                                                                                                                                                                                                                         │
├─────┼────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 2   │ db-migration-steps.ts:435-456                          │ v22 migration creates quality_gates_new without IF NOT EXISTS; a partial-then-retry run hits "table already exists". Add DROP TABLE IF EXISTS quality_gates_new or IF NOT EXISTS.                                                                                                        │
├─────┼────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 3   │ parallel-merge.ts:48 &                                 │ SQL injection via worktree directory names interpolated into sqlite3 CLI queries. Filename allowlist is weak (startsWith("M")). Validate against /^M\d{3}[A-Z0-9-]*$/ or use bound parameters.                                                                                           │
│     │ parallel-monitor-overlay.ts:135,175                    │                                                                                                                                                                                                                                                                                          │
├─────┼────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 4   │ preferences-models.ts:339                              │ updatePreferencesModels regex ^models:[\s\S]*?(?=\n[a-z_]|\n*$) collapses to just the literal "models:" (lookahead matches at first newline). Every /gsd model … write injects a duplicate models block instead of replacing — corrupting YAML. Combined with non-atomic writeFileSync   │
│     │                                                        │ on line 346, a SIGINT mid-write wipes all preferences.                                                                                                                                                                                                                                   │
└─────┴────────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

HIGH (selected — ~70 total across all subsystems)

Auto-mode core (auto*.ts, auto/):
- auto.ts:1859 — getMilestone(meta.milestoneId) reads from possibly-wrong project DB before retry path triggers.
- auto-dispatch.ts:280-285,305-311 — setRewriteCount/incrementUatCount non-atomic; SIGKILL mid-write resets circuit breakers, defeating loop-prevention.
- auto-dispatch.ts:670-683 — Project-research in-flight marker permanently blocks dispatch on SIGTERM mid-prompt-build (no recovery).
- auto-recovery.ts:961-998 — writeBlockerPlaceholder mutates file → DB → event log → placeholder slice with no transaction; partial failure is unrecoverable.
- auto-verification.ts:334 vs auto-post-unit.ts:1066 — Two retry counters use different key schemas (s.currentUnit.id vs ${type}:${id}), so retries from one don't influence the other.
- auto-post-unit.ts:691-764 — sliceMergeStopped flag set after await stopAuto; swallowed runSafely error allows triage to run on a conflicted main checkout.
- auto-worktree.ts:2167-2186 — Throw path (nothing-to-commit safety check) skips restoreShelter() and stash-pop; sheltered milestone dirs and stash are stranded.
- auto-worktree.ts:2074-2076 — nativeCommit returning null is treated as "nothing to commit" but the worktree is destroyed regardless → data loss for .gsd/-only commits.
- auto-artifact-paths.ts:53-116 — parseUnitId outputs joined into paths via non-null asserts (sid!). Operator/queue-controlled unit IDs containing .. could escape milestone dir.
- auto-dashboard.ts:464-466,530-548 — Cross-project widget-mode pref leak: first project loaded wins; subsequent toggles write to the wrong project's preferences file.
- auto-model-selection.ts:373-378 — Unknown previousTier strings silently fall through to lower-tier model on retry.
- auto-start.ts:836-839 — Windows-only regex bug in isUnderGsdWorktrees; on Windows the symlinked layout is never detected, causing re-entry attempts.
- auto/loop.ts:373-390,825-834 — ModelPolicyDispatchBlockedError skips dispatch-ledger settle, leaving rows stuck in running; custom-engine path bypasses openDispatchClaim entirely (no fencing).
- auto/run-unit.ts:79-105 — _setSessionSwitchInFlight(true) set before try; synchronous newSession() throws leak the flag forever, permanently dropping resolveAgentEnd.
- auto/run-unit.ts:154-167 — Order: clear flag → install resolver. Fresh agent_end events arriving in-between are dropped.
- auto/phases.ts:1832-1839,2019-2030 — s.checkpointSha never cleaned up if runUnit throws (git ref leak); s.currentUnit.startedAt race after await runUnit.

DB:
- gsd-db.ts:1591-1605 — setMilestoneQueueOrder issues raw BEGIN IMMEDIATE outside _transactionRunner; nested call corrupts depth tracker.
- gsd-db.ts:702-715 — vacuumDatabase/checkpointDatabase don't gate on isInTransaction().
- gsd-db.ts:1793-1794 — ATTACH DATABASE '${worktreeDbPath}' raw string interpolation (allowlist regex doesn't block backslashes); use ATTACH DATABASE ?.
- gsd-db.ts:438-512 — openDatabaseByWorkspace snapshot/restore leaves a stale cached entry on open-failure.
- db/unit-dispatches.ts:269-271 — markFailed treats retryAfterMs === 0 as "no retry" instead of immediate retry.

Commands:
- commands-pr-branch.ts:213 — Cherry-pick conflict path leaves user on PR branch instead of original; checkout failure throws into outer catch with confusing message.
- commands-bootstrap.ts:38 — Boot-time pref write missing mkdirSync; can ENOENT-crash startup.
- commands-bootstrap.ts:30 & commands-cmux.ts:128-137 — Cmux on clobbers user's per-feature settings; bootstrap re-asserts enabled = true on every boot regardless of user intent.
- commands-do.ts:42, 62-64 — lower.includes(keyword) matches mid-word; /gsd do auto-mode the parser matches "auto" keyword and produces command="auto", args="-mode the parser".
- commands-extensions.ts:594 — parseNpmSpecifier quirks for malformed inputs.
- commands-handlers.ts:39-47 — isBunInstall may misfire on path traversal via BUN_INSTALL env.
- commands-debug.ts:97 — Uses process.cwd() instead of currentDirectoryRoot(); inconsistent with rest of codebase, breaks subdir invocation.
- commands-maintenance.ts:266-282 — handleSkip regex too narrow; non-atomic write to completed-units.json races with concurrent skip.
- commands-memory.ts:392-413 — handleImport not transactional; partial import leaves N memories with 0 relations.
- commands-memory.ts:398-405 — Import drops original memory IDs, breaking the entire relation graph silently.
- commands/handlers/workflow.ts:539 — Race on headless-context.md consumption between concurrent TUI sessions.
- commands-prefs-wizard.ts:1665 — yamlSafeString early-returns String(val) for non-strings; arrays become "1,2", objects "[object Object]".

Workflow / Worktree:
- workflow-events.ts:41-59 — appendEvent not file-locked; races with compactMilestoneEvents truncation and reconcile rewrite. Events appended after readEvents() and before atomicWriteSync() are silently dropped.
- workflow-install.ts:194-200 — Size cap checked AFTER full body buffered (OOM vector via malicious server).
- workflow-projections.ts:438-451 — regenerateIfMissing switch missing default:; filePath may be undefined for new fileTypes → existsSync(undefined) throws.
- workflow-reconcile.ts:485 — Recursive retry on log growth has no bound; concurrent appendEvent + reconcile can spin forever.
- workflow-reconcile.ts:614-670,119-128 — resolveConflict recurses into reconcile, double-replays events; record_verification insert has no idempotency key → duplicate evidence rows.
- custom-workflow-engine.ts:115-218 — Step marked active on disk before dispatch; if injectContext throws after markStepActive/writeGraph, no rollback.
- worktree-command.ts:309 — User-supplied name validation regex permits leading - (e.g. --upload-pack=...); potential git option injection.
- worktree-command.ts:142 — Case-insensitive name collision on macOS/Windows triggers GSD_STALE_STATE instead of graceful switch.
- worktree-manager.ts:561-606 — removeWorktree runs git submodule status → git add -A → git commit chain unsynchronized in a contested worktree (data corruption risk).
- worktree-manager.ts:651-659 — Force-rmSync(wtInternalDir) uses naive join(basePath, ".git", "worktrees", name); doesn't handle worktree-pointer-file .git.
- worktree-resolver.ts:208-282 — enterMilestone lease leaked on worktree-create failure (no release in catch).
- worktree-root.ts:79-95 — resolveProjectRootFromPath falls back to returning the symlinked external state path on git-file resolution failure → writes/reads land in wrong place.
- worktree-session-state.ts:1-3,18 — Module-global originalCwd with no synchronization; CRLF/separator regex is fragile and ignores symlinked external layout.

State / locks / session:
- session-lock.ts:308-316,349-372 — TOCTOU: stale-lock rmSync(lockDir) after PID-dead check can stomp a fresh owner that won the race in between.
- session-status-io.ts:81-88 — isPidAlive returns false on EPERM; on multi-user hosts (CI), foreign-uid sessions are treated as stale and wiped.
- state.ts:269-270 — Dead branch: both arms return mid. Roadmap-completeness no longer matters at that decision point (likely refactor leftover).

Verification / gates / safety:
- verification-gate.ts:147,219 — sanitizeCommand only applied at discovery time for taskPlanVerify; preference-sourced commands skip the injection check entirely.
- verification-gate.ts:267 — spawnSync no maxBuffer; chatty tests overrun 1MB default and report exit 127 ("command not found").
- custom-verification.ts:161 — Dangerous-pattern denylist is security theater (/\$\(||;\s*(rm|curl|...)\b/); doesn't catch && rm, | rm`, redirections, or arbitrary commands not in tiny denylist.
- bootstrap/write-gate.ts:66 — BASH_READ_ONLY_RE not end-anchored; mkdir -p .gsd && rm -rf /tmp/x, cat /etc/passwd ; rm -rf / all match the safe-command regex and are allowed in queue mode.
- pre-execution-checks.ts:215 — Spawn-error in checkPackageOnNpm returns exists:true; missing-npm CI silently passes every package check.

Doctor:
- doctor-environment.ts:296 — Shell injection: df -k "${basePath}" interpolates basePath unescaped.
- doctor-environment.ts:478,507 — npm run build/test use 5s timeout; realistic builds exceed → consistent false-positive failures.
- doctor-environment.ts:114 — Node version regex >=? accepts > as >=, ignores compound ranges; produces false-negatives for <=18.
- doctor-runtime-checks.ts:88-92 — isLockProcessAlive called with synthetic LockData; PID-only check is wrong on systems with PID wrap.
- doctor-runtime-checks.ts:241 — JSON-parse failure on UAT counter triggers file deletion (mistaken for retry exhaustion).
- doctor-proactive.ts:240 — .git/MERGE_HEAD check is blind inside worktrees because .git is a file, not a directory. Pre-dispatch merge-state corruption never detected in worktree-mode auto runs.
- doctor-providers.ts:102 — Provider inference misses deepseek-, qwen-, llama-3- etc.; doctor reports "ok" while no key is configured.
- doctor.ts:464 — Title sanitizer doesn't normalize /; auto-fix loops forever on titles with forward slashes.

Detection / triage / classifier:
- complexity-classifier.ts:203,226 — Path missing "milestones" segment; RESEARCH.md and task plan reads silently always fail. Phase 4 introspection is effectively disabled.
- error-classifier.ts:51,62,67 — Unanchored \b500\b/\b429\b; substrings like "5000ms" get classified as transient server, network errors get rate-limit classification with 60s wait.
- detection.ts:683,742-748 — Module-level SUPPORTED_PLATFORMS_RE with g flag; cross-file lastIndex leak from prior iteration.
- triage-resolution.ts:141-157 — executeBacktrack with bare M001 in user prompt vs current M001-abc123 re-targets the same milestone.

Memory / context / utils:
- memory-store.ts:639 — MEM### 3-digit padding breaks lexicographic sort once seq exceeds 999.
- memory-store.ts:377 — String-substituted activeClause in FTS SQL is a SQL injection foothold for any future caller.
- key-manager.ts:399-409,719-726 — auth.remove() then re-add survivors loop. Crash mid-loop loses ALL credentials for the provider with no recovery.
- paths.ts:539-548 — Walk-up loop terminates immediately after one parent because basePath is mutated and used as termination condition.
- undo.ts:54 — unitId.replace(/-/g, "/") corrupts unit IDs that legitimately contain hyphens.
- forensics.ts:1319 — Anthropic API key redaction misses sk-ant-... (regex stops at first hyphen).

Visualizer / dashboard / notifications:
- visualizer-overlay.ts:96,567 — Mouse tracking enabled globally; no SIGINT handler → terminal left in mouse-tracking mode on abnormal exit.
- notification-store.ts:317-318 — Spinning busy-wait on lock contention pins a CPU core.
- notifications.ts:122-124 — AppleScript escape only handles backslash + double quote; doesn't strip Unicode line separators.
- markdown-renderer.ts:493-567 — Regexes built from unescaped slice/task IDs (new RegExp(...sid:...) without escapeRegExp).
- export-html.ts:953-957 — e.resolution, e.rationale not HTML-escaped → XSS in generated reports.

Slice / parallel / guided-flow:
- slice-parallel-orchestrator.ts:773-776 — Wrong NDJSON path for cost extraction; worker.cost/sliceState.totalCost stay at 0 forever, defeating budget enforcement.
- slice-cadence.ts:185,257,282,343 — process.chdir is process-global; concurrent merges corrupt cwd for everything else in the process.
- slice-parallel-conflict.ts:24-36 — File-extraction regex requires leading non-word char; misses paths at line start. Empty extraction silently allowed (contradicts "conservative" comment).
- guided-flow.ts:536-725,919-989 — _getPendingAutoStart() returns null with >1 entries; multi-project sessions break recovery silently.