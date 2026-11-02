/**
 * Skill cues: discovery reuses pi's own resolution (`getCommands()`), loading
 * reads the SKILL.md pi points at and injects it in pi's native forced-load
 * block format.
 *
 * stripFrontmatter / block formatting adapted from @zigai/pi-mention-skill
 * (MIT License, Copyright (c) zigai). See NOTICE.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { escapeAttribute, escapeEnvelopeTags } from "./envelope.js";

const SKILL_COMMAND_PREFIX = "skill:";

export interface SkillRef {
  name: string;
  path: string;
}

export function resolveSkill(pi: Pick<ExtensionAPI, "getCommands">, name: string): SkillRef | null {
  const command = pi
    .getCommands()
    .find(
      (candidate) =>
        candidate.source === "skill" && candidate.name === `${SKILL_COMMAND_PREFIX}${name}`,
    );
  const path = command?.sourceInfo.path;
  return path ? { name, path } : null;
}

/** Full-text `<skill>` block, mirroring what pi injects for `/skill:name`. */
export function loadSkillBlock(skill: SkillRef): string | null {
  let content: string;
  try {
    content = readFileSync(skill.path, "utf8");
  } catch {
    return null;
  }

  // The skill body is cue content: escape the envelope's own tag names so it
  // cannot close the surrounding `<pi-cues>` block early (ADR 0012).
  const body = escapeEnvelopeTags(stripFrontmatter(content).trim());
  const baseDir = dirname(skill.path);
  return `<skill name="${escapeAttribute(skill.name)}" location="${escapeAttribute(skill.path)}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
}

export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }

  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return content;
  }

  const afterMarker = end + "\n---".length;
  if (content[afterMarker] === "\r" && content[afterMarker + 1] === "\n") {
    return content.slice(afterMarker + 2);
  }
  if (content[afterMarker] === "\n") {
    return content.slice(afterMarker + 1);
  }
  return content.slice(afterMarker);
}
