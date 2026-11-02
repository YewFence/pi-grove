/**
 * Session state: once-per-session dedup, runtime diagnostics, and the
 * triggered-cue log behind `/cues status`.
 *
 * Dedup pattern adapted from pi-rules src/rules/cache.ts (MIT License,
 * Copyright (c) 2026 Yeongyu Kim). See NOTICE.
 */
import type { ActionKind, CueDiagnostic } from "./types.js";

export interface TriggeredRecord {
  action: ActionKind;
  target: string;
  /** Config file that declared the trigger. */
  source: string;
  /** False when the target was missing or failed to load (still deduped). */
  loaded: boolean;
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
 * undefined when the key was already claimed.
 */
export function claimOnce(
  state: SessionState,
  key: string,
  record: TriggeredRecord,
): TriggeredRecord | undefined {
  if (state.dedup.has(key)) {
    return undefined;
  }
  state.dedup.add(key);
  state.triggered.push(record);
  return record;
}

export function clearSession(state: SessionState): void {
  state.dedup.clear();
  state.diagnostics.length = 0;
  state.triggered.length = 0;
}
