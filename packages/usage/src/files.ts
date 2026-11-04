import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export type FileState =
  | { kind: "missing" }
  | { kind: "file"; hash: string; size: number }
  | { kind: "other" }
  | { kind: "unknown" };

/**
 * Content comparison happens locally only; hashes and contents never leave
 * the machine. Unreadable or non-file targets become `other`/`unknown` and
 * can never produce a phantom modification.
 */
export async function snapshotFile(path: string): Promise<FileState> {
  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unknown" };
  }
  if (!stats.isFile()) return { kind: "other" };
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return { kind: "file", hash: hash.digest("hex"), size: stats.size };
  } catch {
    return { kind: "unknown" };
  }
}

export function statesEqual(a: FileState, b: FileState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return a.hash === b.hash && a.size === b.size;
  return a.kind === "missing" || a.kind === "other";
}
