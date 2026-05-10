import { isAbsolute, relative, resolve } from "node:path";
import { normalizePlannedFileReference } from "./files.js";
import { externalGsdRoot } from "./repo-identity.js";

export interface PlanningPathScopeField {
  field: string;
  values: string[];
}

function isInsideRoot(rootPath: string, candidate: string): boolean {
  const root = resolve(rootPath);
  const abs = resolve(candidate);
  const rel = relative(root, abs);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Build the list of allowed roots for absolute paths in planning IO fields.
 *
 * Two roots are always permitted:
 *   1. The active working directory (`basePath`) — covers source files,
 *      generated artifacts inside the worktree, and anything under `.gsd/`
 *      that resolves locally (most projects).
 *   2. The per-project external GSD state directory
 *      (`~/.gsd/projects/<repoHash>/`) — covers canonical project artifacts
 *      that live outside the checkout under the external-state layout
 *      (MEM038): the canonical bug-list, project-scoped notifications, etc.
 *      Without this allowance, plans that legitimately reference these files
 *      cannot satisfy the path-scope guard at all (M002/S04 stuck-loop fix).
 *
 * Returning an array (rather than threading two basePath parameters through)
 * keeps the API stable for future allowed roots (e.g. shared-test-fixtures).
 */
export function planningAllowedRoots(basePath: string): string[] {
  const roots = [basePath];
  try {
    const external = externalGsdRoot(basePath);
    if (resolve(external) !== resolve(basePath)) {
      roots.push(external);
    }
  } catch {
    // externalGsdRoot may throw if repoIdentity cannot resolve a git root
    // (e.g. unit-test fixtures with no .git). In that case, only the basePath
    // root is allowed, matching pre-fix behavior.
  }
  return roots;
}

/**
 * Planning IO fields are execution contracts. Absolute paths are only safe when
 * they stay inside one of the allowed roots; in worktree mode, an absolute
 * path to the original checkout makes executors edit the wrong tree.
 *
 * Allowed roots: the active working directory plus the per-project
 * external GSD state directory (`~/.gsd/projects/<hash>/`). See
 * `planningAllowedRoots` for rationale.
 */
export function validatePlanningPathScope(
  basePath: string,
  fields: PlanningPathScopeField[],
): string | null {
  const roots = planningAllowedRoots(basePath);
  for (const { field, values } of fields) {
    for (const raw of values) {
      const candidate = normalizePlannedFileReference(raw);
      if (!isAbsolute(candidate)) continue;
      if (roots.some((root) => isInsideRoot(root, candidate))) continue;
      const allowedHint =
        roots.length === 1
          ? `Use a path relative to ${roots[0]}.`
          : `Use a path relative to one of: ${roots.join(", ")}.`;
      return `${field} contains absolute path outside working directory: ${candidate}. ${allowedHint}`;
    }
  }

  return null;
}
