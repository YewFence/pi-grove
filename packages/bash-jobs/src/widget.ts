// Derived from pi-codex-conversion
// Copyright (c) 2026 Igor Warzocha
// SPDX-License-Identifier: MIT
// https://github.com/iWarzocha/howaboua-pi-stuff/blob/main/packages/pi-codex-conversion/LICENSE

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const BACKGROUND_JOBS_WIDGET_ID = "pi-bash-jobs-widget";
const OUTPUT_TAIL_CHARS = 4_000;

export interface JobSnapshot {
  id: number;
  command: string;
  state: "running";
  outputTail: string;
  updatedAt: number;
}

export interface WidgetState {
  activeJobId?: number;
  folded: boolean;
  ctx?: ExtensionContext;
}

interface JobsProvider {
  listRunningJobs(tailChars: number): JobSnapshot[];
  killJob(id: number): void;
}

function stripTerminalControlSequences(text: string): string {
  /* eslint-disable no-control-regex */
  const withoutOscAndDcs = text
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B[P_X^][\s\S]*?\u001B\\/g, "");
  return withoutOscAndDcs
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "")
    .replaceAll("\u001B", "");
  /* eslint-enable no-control-regex */
}

function renderTerminalOutput(text: string): string {
  let committed = "";
  let line: string[] = [];
  let cursor = 0;

  for (const char of stripTerminalControlSequences(text)) {
    const code = char.codePointAt(0);
    if (
      code === undefined ||
      (code < 0x20 && char !== "\t" && char !== "\n" && char !== "\r" && char !== "\b") ||
      (code >= 0x7f && code <= 0x9f)
    )
      continue;
    if (char === "\r") {
      cursor = 0;
      continue;
    }
    if (char === "\n") {
      committed += `${line.join("")}\n`;
      line = [];
      cursor = 0;
      continue;
    }
    if (char === "\b") {
      cursor = Math.max(0, cursor - 1);
      continue;
    }
    if (cursor > line.length) line.push(...Array.from({ length: cursor - line.length }, () => " "));
    line[cursor] = char;
    cursor += 1;
  }

  return committed + line.join("");
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function ageLabel(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function jobLabel(ctx: ExtensionContext, job: JobSnapshot, activeJobId: number): string {
  const theme = ctx.ui.theme;
  const label = String(job.id);
  if (job.id === activeJobId) return theme.fg("accent", `[${label}]`);
  return theme.fg("warning", label);
}

function resolveActiveJobId(state: WidgetState, snapshots: JobSnapshot[]): number {
  const requested = state.activeJobId;
  if (requested !== undefined && snapshots.some((job) => job.id === requested)) return requested;
  if (!snapshots[0]) throw new Error("resolveActiveJobId called with empty snapshots");
  const fallback = snapshots[0].id;
  state.activeJobId = fallback;
  return fallback;
}

export function renderWidget(ctx: ExtensionContext, state: WidgetState, jobs: JobsProvider): void {
  if (ctx.mode !== "tui") return;
  const snapshots = jobs.listRunningJobs(OUTPUT_TAIL_CHARS);
  if (snapshots.length === 0) {
    state.activeJobId = undefined;
    state.folded = true;
    ctx.ui.setWidget(BACKGROUND_JOBS_WIDGET_ID, undefined);
    return;
  }
  const activeJobId = resolveActiveJobId(state, snapshots);
  const active = snapshots.find((job) => job.id === activeJobId) ?? snapshots[0];
  if (!active) return;
  const theme = ctx.ui.theme;
  const jobNumbers = snapshots.map((job) => jobLabel(ctx, job, active.id)).join(" ");
  const lines = [
    `${theme.fg("accent", "╭─ bash jobs")} ${theme.fg("warning", "running")} ${theme.fg("dim", `jobs ${jobNumbers}`)}`,
  ];

  if (!state.folded) {
    lines.push(`${theme.fg("muted", "│ $")} ${truncate(active.command, 120)}`);
    const output = renderTerminalOutput(active.outputTail).trimEnd();
    if (output) {
      for (const line of output.split("\n").slice(-6)) {
        lines.push(`${theme.fg("muted", "│")} ${theme.fg("dim", truncate(line, 160))}`);
      }
    } else {
      lines.push(`${theme.fg("muted", "│")} ${theme.fg("dim", "(no output yet)")}`);
    }
    lines.push(
      `${theme.fg("muted", "│")} ${theme.fg("dim", `job ${active.id} · updated ${ageLabel(active.updatedAt)} ago`)}`,
    );
  }

  lines.push(
    `${theme.fg("muted", "╰─")} ${theme.fg("dim", "alt+q/alt+e select · alt+w fold/open · alt+r close")}`,
  );
  ctx.ui.setWidget(BACKGROUND_JOBS_WIDGET_ID, lines, { placement: "aboveEditor" });
}

export function registerShortcuts(pi: ExtensionAPI, state: WidgetState, jobs: JobsProvider): void {
  function rerender(ctx: ExtensionContext): void {
    state.ctx = ctx;
    renderWidget(ctx, state, jobs);
  }

  pi.registerShortcut("alt+w", {
    description: "Fold or open bash jobs widget",
    handler: async (ctx) => {
      state.folded = !state.folded;
      rerender(ctx);
    },
  });
  pi.registerShortcut("alt+q", {
    description: "Previous bash job",
    handler: async (ctx) => {
      const snapshots = jobs.listRunningJobs(OUTPUT_TAIL_CHARS);
      const count = snapshots.length;
      if (count > 0) {
        const activeIndex = Math.max(
          0,
          snapshots.findIndex((job) => job.id === state.activeJobId),
        );
        const selected = snapshots[(activeIndex + count - 1) % count];
        if (selected) state.activeJobId = selected.id;
      }
      rerender(ctx);
    },
  });
  pi.registerShortcut("alt+e", {
    description: "Next bash job",
    handler: async (ctx) => {
      const snapshots = jobs.listRunningJobs(OUTPUT_TAIL_CHARS);
      const count = snapshots.length;
      if (count > 0) {
        const activeIndex = Math.max(
          0,
          snapshots.findIndex((job) => job.id === state.activeJobId),
        );
        const selected = snapshots[(activeIndex + 1) % count];
        if (selected) state.activeJobId = selected.id;
      }
      rerender(ctx);
    },
  });
  pi.registerShortcut("alt+r", {
    description: "Kill active bash job",
    handler: async (ctx) => {
      const snapshots = jobs.listRunningJobs(OUTPUT_TAIL_CHARS);
      const snapshot = snapshots.find((job) => job.id === state.activeJobId) ?? snapshots[0];
      if (snapshot) jobs.killJob(snapshot.id);
      rerender(ctx);
    },
  });
}
