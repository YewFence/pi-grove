import { access } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface ProjectInfo {
  root: string;
  name: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Nearest enclosing jj or git root wins; otherwise the session cwd is the project. */
export async function detectProject(cwd: string): Promise<ProjectInfo> {
  let dir = cwd;
  for (;;) {
    if ((await exists(join(dir, ".jj"))) || (await exists(join(dir, ".git")))) {
      return { root: dir, name: basename(dir) };
    }
    const parent = dirname(dir);
    if (parent === dir) return { root: cwd, name: basename(cwd) };
    dir = parent;
  }
}
