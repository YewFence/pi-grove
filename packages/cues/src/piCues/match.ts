/**
 * picomatch matching for `when.command` / `when.path`.
 *
 * Adapted from pi-rules src/rules/matcher.ts (MIT License,
 * Copyright (c) 2026 Yeongyu Kim). See NOTICE.
 */
import picomatch from "picomatch";

type PathMatcher = (value: string) => boolean;

interface CompiledPatternSet {
  positive: ReadonlyArray<PathMatcher>;
  negative: ReadonlyArray<PathMatcher>;
}

const PICOMATCH_OPTIONS = { bash: true, dot: true };
const MAX_COMPILED_PATTERN_SET_CACHE_ENTRIES = 256;
const compiledPatternSets = new Map<string, CompiledPatternSet>();

export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * True when any of `values` matches a positive pattern and no negative
 * pattern (`!` prefix) excludes it. `values` are POSIX-normalized path bases
 * for `when.path`, command basenames for `when.command`.
 */
export function matchAnyValue(patterns: readonly string[], values: readonly string[]): boolean {
  if (patterns.length === 0 || values.length === 0) {
    return false;
  }

  const { positive, negative } = compiledPatternSetFor(patterns.map(normalizePath));
  for (const isMatch of positive) {
    for (const value of values) {
      if (!isMatch(value)) {
        continue;
      }
      if (negative.some((isExcluded) => isExcluded(value))) {
        return false;
      }
      return true;
    }
  }

  return false;
}

export function resetMatcherCache(): void {
  compiledPatternSets.clear();
}

function compiledPatternSetFor(patterns: readonly string[]): CompiledPatternSet {
  const cacheKey = patterns.join("\0");
  const cached = compiledPatternSets.get(cacheKey);
  if (cached !== undefined) {
    compiledPatternSets.delete(cacheKey);
    compiledPatternSets.set(cacheKey, cached);
    return cached;
  }

  const positive: PathMatcher[] = [];
  const negative: PathMatcher[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      negative.push(picomatch(pattern.slice(1), PICOMATCH_OPTIONS));
      continue;
    }
    positive.push(picomatch(pattern, PICOMATCH_OPTIONS));
  }

  const compiled: CompiledPatternSet = { positive, negative };
  if (compiledPatternSets.size >= MAX_COMPILED_PATTERN_SET_CACHE_ENTRIES) {
    const oldestKey = compiledPatternSets.keys().next().value;
    if (oldestKey !== undefined) {
      compiledPatternSets.delete(oldestKey);
    }
  }
  compiledPatternSets.set(cacheKey, compiled);
  return compiled;
}
