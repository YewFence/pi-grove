/**
 * Session state: once-per-session dedup, runtime diagnostics, and the
 * triggered-cue log behind `/cues status`.
 *
 * Dedup pattern adapted from pi-rules src/rules/cache.ts (MIT License,
 * Copyright (c) 2026 Yeongyu Kim). See NOTICE.
 */
import type { ActionKind, CueDiagnostic } from "./types.js";

/** customType of the session entry pi-cues appends for each fired cue. */
export const TRIGGERED_ENTRY_TYPE = "pi-cues-triggered";

export interface TriggeredRecord {
  action: ActionKind;
  target: string;
  /** Config file that declared the trigger. */
  source: string;
  /** False when the target was missing or failed to load (still deduped). */
  loaded: boolean;
  /** Dedup key claimed by this firing; the identity persisted across resume. */
  key: string;
  /** True on a repeat-policy trigger's first firing; false on later re-firings, which claim no dedup key and persist no session entry. */
  first: boolean;
}

export interface SessionState {
  dedup: Set<string>;
  diagnostics: CueDiagnostic[];
  triggered: TriggeredRecord[];
}

export function createSessionState(): SessionState {
  return { dedup: new Set(), diagnostics: [], triggered: [] };
}

export function dedupKey(action: ActionKind, identity: string): string {
  return `${action}:${identity}`;
}

/**
 * Record `key` as fired. Returns the stored record on the first firing,
 * undefined when the key was already claimed. With `repeat`, an already
 * claimed key instead returns a non-persisting re-firing record (`first:
 * false`) — the caller injects again but writes no session entry.
 */
export function claimOnce(
  state: SessionState,
  key: string,
  record: Omit<TriggeredRecord, "key" | "first">,
  repeat = false,
): TriggeredRecord | undefined {
  if (state.dedup.has(key)) {
    if (!repeat) {
      return undefined;
    }
    const refired: TriggeredRecord = { ...record, key, first: false };
    state.triggered.push(refired);
    return refired;
  }
  state.dedup.add(key);
  const stored: TriggeredRecord = { ...record, key, first: true };
  state.triggered.push(stored);
  return stored;
}

export function clearSession(state: SessionState): void {
  state.dedup.clear();
  state.diagnostics.length = 0;
  state.triggered.length = 0;
}

const TRIGGERED_ACTIONS: readonly ActionKind[] = [
  "skill",
  "file",
  "walkup",
  "inline",
  "exec",
  "confirm",
];

/** Shape-check one persisted session entry; sessions can predate this format. */
function triggeredEntryData(entry: unknown): TriggeredRecord | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const { type, customType, data } = entry as Record<string, unknown>;
  if (type !== "custom" || customType !== TRIGGERED_ENTRY_TYPE) {
    return undefined;
  }
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const { key, action, target, source, loaded } = data as Record<string, unknown>;
  if (
    typeof key !== "string" ||
    typeof action !== "string" ||
    typeof target !== "string" ||
    typeof source !== "string" ||
    typeof loaded !== "boolean" ||
    !TRIGGERED_ACTIONS.includes(action as ActionKind)
  ) {
    return undefined;
  }
  // `first` is absent from entries persisted before it existed; a persisted
  // firing is always the first one by construction.
  return { key, action: action as ActionKind, target, source, loaded, first: true };
}

/**
 * Rebuild dedup from custom entries on the active branch (session resume,
 * reload, fork). The caller passes compaction-aware entries, so firings whose
 * injections were compacted away re-fire — matching clearSession-on-compact.
 * Returns how many records were restored.
 */
export function restoreFromEntries(state: SessionState, entries: readonly unknown[]): number {
  let restored = 0;
  for (const entry of entries) {
    const record = triggeredEntryData(entry);
    if (record === undefined || state.dedup.has(record.key)) {
      continue;
    }
    state.dedup.add(record.key);
    state.triggered.push(record);
    restored += 1;
  }
  return restored;
}
