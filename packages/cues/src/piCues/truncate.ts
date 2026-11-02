/**
 * Cue bodies under a per-event character budget, wrapped in `<file>` blocks;
 * command output gets a `<command-output>` block instead. The envelope around
 * them belongs to envelope.ts (ADR 0012).
 *
 * Budget handling adapted from pi-rules truncator.ts / formatter.ts
 * (MIT License, Copyright (c) 2026 Yeongyu Kim). See NOTICE.
 */

import { escapeAttribute, escapeEnvelopeTags } from "./envelope.js";

export const MAX_FILE_CHARS = 12000;
export const MAX_RESULT_CHARS = 40000;

const TRUNCATION_NOTICE = "\n\n[Content truncated. Read full file: {path}]";
const COMMAND_TRUNCATION_NOTICE = "\n\n[Output truncated. Re-run the command to see the rest.]";
const BLOCK_SEPARATOR = "\n";
const BLOCK_CLOSE = "\n</file>";
const COMMAND_BLOCK_CLOSE = "\n</command-output>";

export interface FileContent {
  /** Absolute path shown on the `<file>` block. */
  path: string;
  body: string;
}

/**
 * `<file>` blocks for the given (already prioritized) files. Later files are
 * dropped when `budget` runs out. Bodies are boundary-escaped before they are
 * measured, so the budget covers exactly what reaches the model.
 */
export function formatFileBlock(files: readonly FileContent[], budget: number): string {
  const blocks: string[] = [];
  let remaining = budget;

  for (const file of files) {
    const open = `<file path="${escapeAttribute(file.path)}">\n`;
    const notice = TRUNCATION_NOTICE.replace("{path}", file.path);
    const separator = blocks.length === 0 ? 0 : BLOCK_SEPARATOR.length;
    const bodyBudget = remaining - separator - open.length - BLOCK_CLOSE.length;
    if (bodyBudget <= notice.length) {
      break;
    }

    const body = truncateBody(
      escapeEnvelopeTags(file.body),
      Math.min(MAX_FILE_CHARS, bodyBudget),
      notice,
    );
    const block = `${open}${body}${BLOCK_CLOSE}`;
    blocks.push(block);
    remaining -= separator + block.length;
  }

  return blocks.join(BLOCK_SEPARATOR);
}

export interface CommandOutput {
  /** The command line that ran, shown on the `<command-output>` block. */
  command: string;
  body: string;
}

/**
 * One `<command-output>` block for a command's output, under the same budget
 * rules as `formatFileBlock`. The truncation notice differs: output has no
 * path to re-read, the model can only re-run the command.
 */
export function formatCommandOutputBlock(output: CommandOutput, budget: number): string {
  const open = `<command-output command="${escapeAttribute(output.command)}">\n`;
  const bodyBudget = budget - open.length - COMMAND_BLOCK_CLOSE.length;
  if (bodyBudget <= COMMAND_TRUNCATION_NOTICE.length) {
    return "";
  }

  const body = truncateBody(
    escapeEnvelopeTags(output.body),
    Math.min(MAX_FILE_CHARS, bodyBudget),
    COMMAND_TRUNCATION_NOTICE,
  );
  return `${open}${body}${COMMAND_BLOCK_CLOSE}`;
}

function truncateBody(body: string, maxChars: number, notice: string): string {
  if (body.length <= maxChars) {
    return body;
  }

  if (maxChars <= notice.length) {
    return notice;
  }

  return `${body.slice(0, safeSliceEnd(body, maxChars - notice.length))}${notice}`;
}

/** Avoid splitting a surrogate pair or a boundary escape entity at the cut. */
function safeSliceEnd(body: string, end: number): number {
  if (end <= 0) {
    return 0;
  }

  let cut = end;
  const lastCodeUnit = body.charCodeAt(cut - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    cut -= 1;
  }

  // `&lt;` is the only entity escapeEnvelopeTags introduces; keep it whole.
  const ampIndex = body.lastIndexOf("&", cut - 1);
  if (ampIndex !== -1 && cut - ampIndex <= 4 && !body.slice(ampIndex, cut).includes(";")) {
    cut = ampIndex;
  }
  return cut;
}
