/**
 * Walk-up context discovery for the `walkup` action.
 *
 * Walk direction and single-file checks adapted from pi-rules finder.ts /
 * scanner.ts (MIT License, Copyright (c) 2026 Yeongyu Kim). See NOTICE.
 *
 * The walk starts at the operated file's directory and climbs to the session
 * cwd (inclusive). Files outside the cwd subtree do not trigger walk-up at
 * all: their context is not the session's business.
 */
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface WalkupFile {
  /** Path as discovered (possibly through a symlink). */
  path: string;
  /** Canonical path used for dedup against native context files. */
  realPath: string;
}

interface CachedCandidate {
  path: string;
  /** `mtimeMs:size`, or `missing` so a later-created file invalidates the entry. */
  fingerprint: string;
}

interface CacheEntry {
  fileNames: string[];
  walkDirs: string[];
  /** One candidate per (walk dir × file name), near → far. */
  candidates: CachedCandidate[];
}

export interface WalkupCache {
  entries: Map<string, CacheEntry>;
}

export function createWalkupCache(): WalkupCache {
  return { entries: new Map() };
}

/** Existing target files for `fileNames`, near → far. */
export function collectContextFiles(options: {
  anchorDir: string;
  targetFile: string;
  fileNames: readonly string[];
  cache: WalkupCache;
}): WalkupFile[] {
  const targetDir = dirname(resolve(options.targetFile));
  const cached = options.cache.entries.get(targetDir);
  if (cached !== undefined && sameFileNames(cached.fileNames, options.fileNames)) {
    const hit = revalidate(cached);
    if (hit !== null) {
      return hit;
    }
  }

  const walkDirs = getWalkDirectories(options.anchorDir, options.targetFile);
  const candidates: CachedCandidate[] = [];
  for (const dir of walkDirs) {
    for (const fileName of options.fileNames) {
      const path = join(dir, fileName);
      candidates.push({ path, fingerprint: fingerprintOf(path) });
    }
  }
  options.cache.entries.set(targetDir, { fileNames: [...options.fileNames], walkDirs, candidates });
  return existingFiles(candidates);
}

/** Walk from the target file's directory up to `anchorDir` (inclusive), near → far. */
export function getWalkDirectories(anchorDir: string, targetFile: string): string[] {
  const anchor = resolve(anchorDir);
  const start = dirname(resolve(targetFile));
  if (!isSameOrChildPath(start, anchor)) {
    return [];
  }

  const walkDirs = [start];
  let current = start;
  while (current !== anchor) {
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
    walkDirs.push(current);
  }
  return walkDirs;
}

/**
 * Cache hit only when every candidate fingerprint still matches; any change
 * (including `missing` → existing) forces a rediscovery.
 */
function revalidate(entry: CacheEntry): WalkupFile[] | null {
  for (const candidate of entry.candidates) {
    if (fingerprintOf(candidate.path) !== candidate.fingerprint) {
      return null;
    }
  }
  return existingFiles(entry.candidates);
}

function existingFiles(candidates: readonly CachedCandidate[]): WalkupFile[] {
  return candidates
    .filter((candidate) => candidate.fingerprint !== "missing")
    .map((candidate) => ({ path: candidate.path, realPath: realPathOf(candidate.path) }));
}

function sameFileNames(cached: readonly string[], requested: readonly string[]): boolean {
  return (
    cached.length === requested.length && cached.every((name, index) => name === requested[index])
  );
}

function fingerprintOf(filePath: string): string {
  try {
    const stats = statSync(filePath);
    return stats.isFile() ? `${stats.mtimeMs}:${stats.size}` : "missing";
  } catch {
    return "missing";
  }
}

function realPathOf(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}

function isSameOrChildPath(childPath: string, parentPath: string): boolean {
  const childRelativePath = relative(parentPath, childPath);
  return (
    childRelativePath === "" ||
    (!childRelativePath.startsWith("..") && !isAbsolute(childRelativePath))
  );
}
