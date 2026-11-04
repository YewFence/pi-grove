/** Maps a file path to a display language; unknown files carry no language attribute. */

const BY_EXTENSION: Record<string, string> = {
  bash: "Bash",
  c: "C",
  cfg: "INI",
  clj: "Clojure",
  cmake: "CMake",
  conf: "INI",
  cpp: "C++",
  cs: "C#",
  css: "CSS",
  cts: "TypeScript",
  cxx: "C++",
  dart: "Dart",
  erl: "Erlang",
  ex: "Elixir",
  exs: "Elixir",
  fish: "Fish",
  go: "Go",
  graphql: "GraphQL",
  h: "C",
  hcl: "HCL",
  hpp: "C++",
  hs: "Haskell",
  html: "HTML",
  ini: "INI",
  java: "Java",
  jl: "Julia",
  js: "JavaScript",
  json: "JSON",
  jsonc: "JSON",
  jsx: "JavaScript",
  kt: "Kotlin",
  lua: "Lua",
  markdown: "Markdown",
  md: "Markdown",
  mjs: "JavaScript",
  ml: "OCaml",
  mts: "TypeScript",
  nix: "Nix",
  php: "PHP",
  proto: "Protocol Buffers",
  py: "Python",
  pyi: "Python",
  r: "R",
  rb: "Ruby",
  rs: "Rust",
  scala: "Scala",
  scss: "SCSS",
  sh: "Bash",
  sql: "SQL",
  svelte: "Svelte",
  swift: "Swift",
  tex: "TeX",
  tf: "HCL",
  toml: "TOML",
  ts: "TypeScript",
  tsx: "TypeScript",
  typ: "Typst",
  vue: "Vue",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  zig: "Zig",
  zsh: "Bash",
};

const BY_BASENAME: Record<string, string> = {
  "cmakelists.txt": "CMake",
  containerfile: "Dockerfile",
  dockerfile: "Dockerfile",
  "go.mod": "Go",
  "go.sum": "Go",
  justfile: "Just",
  makefile: "Makefile",
};

export function languageForPath(path: string): string | undefined {
  const base = path.split(/[\\/]/).pop()?.toLowerCase();
  if (!base) return undefined;
  const named = BY_BASENAME[base];
  if (named) return named;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return BY_EXTENSION[base.slice(dot + 1)];
}
