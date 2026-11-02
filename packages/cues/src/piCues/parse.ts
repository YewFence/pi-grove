/**
 * Bash command extraction on top of shell-quote.
 *
 * shell-quote's parse() output: strings for words, { op } objects for
 * operators. Only |, ||, &&, ; separate simple commands — redirection ops
 * (>, >>, <<, >&) must not split, or `jj log > out.txt` would report
 * "out.txt" as a command. $(...) content sits between { op: "(" } and
 * { op: ")" } and is skipped with depth tracking. parse() almost never
 * throws (unclosed quotes still return tokens); the try/catch is defensive.
 *
 * The match value for each simple command is the command name (basename of
 * the first word after stripping env assignments and known wrappers) plus
 * its leading positional words, space-joined: `jj edit -r abc` yields
 * "jj edit", while bare `jj` yields "jj". Flags and flag values stop the
 * word run — `-r abc` is not part of the match value. This lets
 * `when.command` patterns address subcommands ("jj edit") as well as bare
 * commands ("jj"), and picomatch globbing covers the rest ("jj edit *").
 *
 * Full verification matrix lives in docs/design.md ("spike 结论").
 */
import { basename } from "node:path";

import { parse, type ParseEntry } from "shell-quote";

/** Shell operator that separates two simple commands. */
const SIMPLE_COMMAND_SEPARATORS = new Set(["|", "||", "&&", ";"]);

const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;

/**
 * Command wrappers stripped one layer. Entries are word sequences because
 * wrappers like `uv run` span two words. `mise x` additionally tolerates a
 * trailing `--` (`mise x -- jj log`).
 */
const WRAPPERS: ReadonlyArray<readonly string[]> = [
  ["sudo"],
  ["env"],
  ["npx"],
  ["bunx"],
  ["uv", "run"],
  ["mise", "x"],
  ["mise", "run"],
];

/**
 * One extracted simple command: the command basename plus its leading
 * positional words, kept as separate words so matching can treat a pattern
 * as a word-level prefix.
 */
export interface ExtractedCommand {
  /** Command basename, e.g. "jj". */
  name: string;
  /** Leading positional words after the command (stops at the first flag), e.g. ["edit"]. */
  positionals: string[];
}

/**
 * Extract match candidates for when.command. For each simple command, emit
 * every word-level prefix of "name + positionals": `jj edit abc` yields
 * ["jj", "jj edit", "jj edit abc"]. A pattern therefore matches when it
 * equals one of these prefixes (or globs one, e.g. "jj edit *"). This keeps
 * `"jj"` matching every jj invocation while allowing subcommand-addressed
 * patterns like `"jj edit"`.
 */
export function extractCommands(command: string): string[] {
  const values: string[] = [];
  for (const { name, positionals } of extractCommandEntries(command)) {
    const words = [name, ...positionals];
    for (let end = 1; end <= words.length; end++) {
      values.push(words.slice(0, end).join(" "));
    }
  }
  return [...new Set(values.filter((value) => value.length > 0))];
}

function extractCommandEntries(command: string): ExtractedCommand[] {
  let entries: ParseEntry[];
  try {
    entries = parse(command);
  } catch {
    return [];
  }

  const commands: ExtractedCommand[] = [];
  let depth = 0;
  let inRedirection = false;
  let currentWords: string[] = [];

  const flush = (): void => {
    const extracted = extractSimpleCommand(currentWords);
    if (extracted !== undefined) {
      commands.push(extracted);
    }
    currentWords = [];
  };

  for (const entry of entries) {
    if (typeof entry === "string") {
      if (depth === 0 && !inRedirection) {
        currentWords.push(entry);
      }
      continue;
    }
    if (!("op" in entry)) {
      // { pattern, ... } / { comment } entries: not a word, not a separator.
      continue;
    }
    if (entry.op === "(") {
      depth += 1;
      continue;
    }
    if (entry.op === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) {
      continue;
    }
    if (SIMPLE_COMMAND_SEPARATORS.has(entry.op)) {
      inRedirection = false;
      flush();
      continue;
    }
    // Redirections (>, >>, <<, >&, 2>, …) terminate the current command, but
    // the words that follow belong to the redirection target ("out.txt" in
    // `jj log > out.txt`), not to a new command — so flush and swallow words
    // until the next real separator instead of starting a fresh command.
    if (/^\d*$/.test(entry.op) || "<>&".includes(entry.op)) {
      inRedirection = true;
      flush();
      continue;
    }
  }
  flush();

  return commands;
}

/**
 * The command basename and its run of positional words, stopping at the
 * first flag-like word (`-anything`, including a bare `$` — the first token
 * of a command substitution like `$(jj st)`). Flags end the run because a
 * flag's value (`jj log -r abc`) is not a subcommand; keeping it would let
 * `when.command = "jj log abc"` match `jj log -r abc`, which reads as
 * nonsense.
 */
function extractSimpleCommand(words: string[]): ExtractedCommand | undefined {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined) {
      break;
    }
    if (ENV_ASSIGNMENT.test(word)) {
      index += 1;
      continue;
    }
    const wrapperLength = matchWrapper(words, index);
    if (wrapperLength > 0) {
      index += wrapperLength;
      // Wrapper flags and the `mise x -- cmd` separator precede the command.
      while (words[index]?.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    const commandName = basename(word);
    const positionals: string[] = [];
    let cursor = index + 1;
    while (cursor < words.length) {
      const next = words[cursor];
      if (next === undefined || next.startsWith("-") || next === "$") {
        break;
      }
      positionals.push(next);
      cursor += 1;
    }
    return { name: commandName, positionals };
  }
  return undefined;
}

/** Number of words consumed by the wrapper starting at index, or 0. */
function matchWrapper(words: string[], index: number): number {
  for (const wrapper of WRAPPERS) {
    if (wrapper.every((word, offset) => words[index + offset] === word)) {
      return wrapper.length;
    }
  }
  return 0;
}
