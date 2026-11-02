/**
 * read/edit/write path extraction and the multi-base values used for
 * `when.path` matching.
 *
 * Adapted from pi-rules src/rules/tool-paths.ts (MIT License,
 * Copyright (c) 2026 Yeongyu Kim). See NOTICE.
 */
import { basename, isAbsolute, relative, resolve } from "node:path";

import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

import { normalizePath } from "./match.js";

const PATH_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "edit", "write"]);

export interface PathBases {
  projectRelative: string;
  scopeRelative: string;
  basename: string;
}

/**
 * Absolute paths the tool operated on. A failed read/edit/write reports the
 * problem instead of the settled content, so no path cue fires for it.
 */
export function extractToolPaths(event: ToolResultEvent, cwd: string): string[] {
  if (event.isError || !PATH_TOOL_NAMES.has(event.toolName)) {
    return [];
  }

  const filePaths = new Set<string>();
  if (event.toolName === "read" || event.toolName === "edit") {
    addPath(filePaths, getStringProperty(event.details, "filePath"), cwd);
    addPath(filePaths, getStringProperty(event.input, "path"), cwd);
  }
  if (event.toolName === "write") {
    addPath(filePaths, getStringProperty(event.input, "filePath"), cwd);
    addPath(filePaths, getStringProperty(event.input, "path"), cwd);
  }

  return [...filePaths];
}

export function toPathBases(filePath: string, cwd: string, scopeDir: string): PathBases {
  return {
    projectRelative: normalizePath(relative(cwd, filePath)),
    scopeRelative: normalizePath(relative(scopeDir, filePath)),
    basename: basename(filePath),
  };
}

export function pathBaseValues(bases: PathBases): string[] {
  return [bases.projectRelative, bases.scopeRelative, bases.basename];
}

function addPath(filePaths: Set<string>, filePath: string | undefined, cwd: string): void {
  if (filePath === undefined || filePath.length === 0) {
    return;
  }

  filePaths.add(isAbsolute(filePath) ? filePath : resolve(cwd, filePath));
}

function getStringProperty(value: unknown, propertyName: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const propertyValue = (value as Record<string, unknown>)[propertyName];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}
