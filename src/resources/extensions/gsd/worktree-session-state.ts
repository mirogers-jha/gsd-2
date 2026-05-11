// Project/App: GSD-2
// File Purpose: Hybrid AsyncLocalStorage + per-resolver registry + module-global
// fallback for worktree "originalCwd" tracking. Replaces the prior single
// module-global slot which caused confused-deputy cross-talk between concurrent
// `enterMilestone` calls. Also exports a normalizer + realpath fallback so the
// marker-match path tolerates CRLF tails, backslash separators, and
// symlinked-external `~/.gsd/projects/<hash>/...` layouts.
//
// Resolution order (`getWorktreeOriginalCwd`):
//   1. AsyncLocalStorage store — set by `withWorktreeOriginalCwd(cwd, fn)`.
//   2. Per-resolver registry — last-registered `WorktreeResolver` wins.
//   3. Module-global fallback — preserved for legacy callers; emits a
//      `logWarning` so callers can be migrated incrementally.
//
// M003/S04 Bug 3 (D004 reproduce-and-prevent test:
// `tests/worktree-session-state-cross-talk.test.ts`).

import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { logWarning } from "./workflow-logger.js";

// ─── Module-global fallback (legacy callers) ────────────────────────────────

let _moduleGlobalOriginalCwd: string | null = null;

// ─── ALS store (new entry-points) ───────────────────────────────────────────

const worktreeOriginalCwdStore = new AsyncLocalStorage<{
  originalCwd: string | null;
}>();

// ─── Per-resolver registry (hybrid lookup) ──────────────────────────────────

/** Subset of `WorktreeResolver` shape consumed by the hybrid resolver — kept
 *  intentionally narrow so tests can substitute a plain object. */
export interface ResolverLike {
  s: { originalCwd?: string | null };
}

const _activeResolvers: Set<ResolverLike> = new Set();

export function registerActiveResolver(r: ResolverLike): void {
  _activeResolvers.add(r);
}

export function unregisterActiveResolver(r: ResolverLike): void {
  _activeResolvers.delete(r);
}

/** TEST-ONLY: clear the registry between sub-tests. Production code never
 *  calls this — the registry is process-lifetime. */
export function _resetActiveResolversForTests(): void {
  _activeResolvers.clear();
}

// ─── Public API — getters/setters ───────────────────────────────────────────

export function getWorktreeOriginalCwd(): string | null {
  // 1. ALS store wins (per-context isolation across concurrent awaits).
  const store = worktreeOriginalCwdStore.getStore();
  if (store && store.originalCwd !== null) return store.originalCwd;

  // 2. Per-resolver registry — last-registered wins (Set iteration order is
  //    insertion order, so we walk all and prefer the most recent non-null).
  let registryHit: string | null = null;
  for (const r of _activeResolvers) {
    if (r.s.originalCwd) registryHit = r.s.originalCwd;
  }
  if (registryHit !== null) return registryHit;

  // 3. Module-global fallback — log so callers can be migrated.
  if (_moduleGlobalOriginalCwd) {
    logWarning(
      "worktree",
      "getWorktreeOriginalCwd: using module-global fallback (legacy caller)",
    );
  }
  return _moduleGlobalOriginalCwd;
}

export function setWorktreeOriginalCwd(cwd: string): void {
  // Write to module-global (legacy compat) AND any registered resolver so
  // both lookup paths see the same value. Active ALS contexts are NOT
  // touched — they own their own slot via `withWorktreeOriginalCwd`.
  _moduleGlobalOriginalCwd = cwd;
  for (const r of _activeResolvers) {
    r.s.originalCwd = cwd;
  }
}

export function clearWorktreeOriginalCwd(): void {
  _moduleGlobalOriginalCwd = null;
  for (const r of _activeResolvers) {
    r.s.originalCwd = null;
  }
}

export function withWorktreeOriginalCwd<T>(
  cwd: string | null,
  fn: () => T,
): T {
  return worktreeOriginalCwdStore.run({ originalCwd: cwd }, fn);
}

// ─── Path normalization ─────────────────────────────────────────────────────

/** Normalize a cwd-like path for marker matching:
 *  - convert backslashes → forward slashes (Windows / mixed inputs)
 *  - strip trailing CRLF / LF runs (clipboard / shell-pipe leaks)
 *  Idempotent; safe to apply twice. */
export function normalizeCwdForMatching(cwd: string): string {
  return cwd.replaceAll("\\", "/").replace(/\r?\n+$/, "");
}

// ─── Marker-based recovery (with realpath fallback) ─────────────────────────

const WORKTREE_MARKER = "/.gsd/worktrees/";

export function ensureWorktreeOriginalCwdFromPath(
  cwd: string = process.cwd(),
): string | null {
  const existing = getWorktreeOriginalCwd();
  if (existing) return existing;

  const normalized = normalizeCwdForMatching(cwd);
  const idx = normalized.indexOf(WORKTREE_MARKER);
  if (idx !== -1) {
    const root = normalized.slice(0, idx);
    setWorktreeOriginalCwd(root);
    return root;
  }

  // Symlinked-external layout fallback: caller cwd may be a symlink whose
  // target lives in `~/.gsd/projects/<hash>/worktrees/...`. Resolve realpath
  // and retry the marker match. Graceful null on any fs error (broken
  // symlinks, permission denied, etc).
  try {
    const real = realpathSync(cwd);
    const realNorm = normalizeCwdForMatching(real);
    const realIdx = realNorm.indexOf(WORKTREE_MARKER);
    if (realIdx !== -1) {
      const root = realNorm.slice(0, realIdx);
      setWorktreeOriginalCwd(root);
      return root;
    }
  } catch {
    // Non-fatal — return null below.
  }
  return null;
}

export function getActiveWorktreeName(): string | null {
  const original = getWorktreeOriginalCwd();
  if (!original) return null;

  const wtDir =
    `${original.replace(/[\\/]+$/, "")}/.gsd/worktrees`.replaceAll("\\", "/");

  let normalizedCwd = normalizeCwdForMatching(process.cwd());
  if (!normalizedCwd.startsWith(`${wtDir}/`)) {
    // Symlinked-external fallback — try realpath of cwd.
    try {
      const real = realpathSync(process.cwd());
      normalizedCwd = normalizeCwdForMatching(real);
    } catch {
      return null;
    }
    if (!normalizedCwd.startsWith(`${wtDir}/`)) return null;
  }

  const rel = normalizedCwd.slice(wtDir.length + 1);
  const name = rel.split("/")[0];
  return name || null;
}
