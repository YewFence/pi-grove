/**
 * Injection envelope: one `<pi-cues>` block per cue. The open tag carries
 * attribution, the close tag is the boundary the model can actually trust
 * (ADR 0012). Everything format-related lives here so truncate.ts stays about
 * bodies only.
 */

import type { ActionKind } from "./types.js";

/** Verbatim first line of every envelope; never varies with the action. */
export const ENVELOPE_NOTICE = "pi-cues: injected context, not tool output or user input.";

/** The envelope's own tag names; a `<` in front of them is escaped in bodies. */
const ENVELOPE_TAGS = ["pi-cues", "file", "skill", "command-output"] as const;

const CLOSE_TAG = "</pi-cues>";

export interface EnvelopeMeta {
  action: ActionKind;
  /** What matched: `command {name}` or `path {operated path}`. */
  trigger: string;
  /** `inline` only: the config file that declared the injected sentence. */
  source?: string;
}

/** `<pi-cues action=… trigger=…>`, notice line, blank line, content, blank line, close tag. */
export function formatEnvelope(meta: EnvelopeMeta, content: string): string {
  return `${openTag(meta)}\n${ENVELOPE_NOTICE}\n\n${content}\n\n${CLOSE_TAG}`;
}

/** Characters the envelope spends on everything but the content. */
export function envelopeOverhead(meta: EnvelopeMeta): number {
  return openTag(meta).length + 1 + ENVELOPE_NOTICE.length + 2 + 2 + CLOSE_TAG.length;
}

/**
 * Escape `<` in front of the envelope's own tag names, so the first
 * `</pi-cues>` inside the block is always the real close tag and a body cannot
 * close the inner `<file>` / `<skill>` / `<command-output>` early. Nothing else is
 * touched: other markdown stays byte-identical. Case-sensitive by design.
 */
export function escapeEnvelopeTags(text: string): string {
  let escaped = text;
  for (const tag of ENVELOPE_TAGS) {
    escaped = escaped.replaceAll(`<${tag}`, `&lt;${tag}`).replaceAll(`</${tag}`, `&lt;/${tag}`);
  }
  return escaped;
}

export function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function openTag(meta: EnvelopeMeta): string {
  const attributes = [
    `action="${escapeAttribute(meta.action)}"`,
    `trigger="${escapeAttribute(meta.trigger)}"`,
  ];
  if (meta.source !== undefined) {
    attributes.push(`source="${escapeAttribute(meta.source)}"`);
  }
  return `<pi-cues ${attributes.join(" ")}>`;
}
