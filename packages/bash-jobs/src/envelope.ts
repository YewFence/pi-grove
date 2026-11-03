export interface HookDiagnostic {
  action: "source-hook" | "config";
  outcome?: "failed" | "warning";
  hook?: string;
  message: string;
  stderr?: string;
}

export const FIRST_HOOK_ERROR_NOTICE =
  "pi-bash-jobs: an environment preparation hook failed. Its environment update was skipped; the requested command still runs. The following block contains the hook’s error output.";

export const FIRST_HOOK_WARNING_NOTICE =
  "pi-bash-jobs: an environment preparation hook succeeded and wrote to stderr. Its generated initialization code will run before the requested command. The following block contains the hook’s stderr output.";

const MAX_ENVELOPE_CHARS = 8_192;
const TRUNCATION_NOTICE = "\n[Diagnostic output truncated.]";

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeBody(value: string): string {
  return value.replace(/<\/?(?:pi-bash-jobs|command-output)/g, (tag) => `&lt;${tag.slice(1)}`);
}

/** Keeps diagnostic boundaries intact even when external output contains tags or needs truncation. */
export function formatDiagnostic(diagnostic: HookDiagnostic, explain: boolean): string {
  const hook =
    diagnostic.hook === undefined
      ? ""
      : ` hook="${escapeAttribute(diagnostic.hook.slice(0, 256))}"`;
  const open = `<pi-bash-jobs action="${diagnostic.action}"${hook} outcome="${diagnostic.outcome ?? "failed"}">`;
  const notice = explain
    ? diagnostic.action === "source-hook"
      ? `${diagnostic.outcome === "warning" ? FIRST_HOOK_WARNING_NOTICE : FIRST_HOOK_ERROR_NOTICE}\n\n`
      : "pi-bash-jobs: environment preparation configuration has errors. Valid hooks and the requested command still run. The following block contains the configuration errors.\n\n"
    : "";
  const stderrOpen = diagnostic.stderr ? '\n\n<command-output stream="stderr">\n' : "";
  const stderrClose = diagnostic.stderr ? "\n</command-output>" : "";
  const close = "\n\n</pi-bash-jobs>";
  const prefix = `${open}\n${notice}`;
  const budget =
    MAX_ENVELOPE_CHARS - prefix.length - stderrOpen.length - stderrClose.length - close.length;
  let message = escapeBody(diagnostic.message);
  let stderr = escapeBody(diagnostic.stderr ?? "");
  if (message.length + stderr.length > budget) {
    const available = budget - TRUNCATION_NOTICE.length;
    message = message.slice(0, available);
    stderr = stderr.slice(0, available - message.length);
    if (diagnostic.stderr) stderr += TRUNCATION_NOTICE;
    else message += TRUNCATION_NOTICE;
  }
  return `${prefix}${message}${stderrOpen}${stderr}${stderrClose}${close}`;
}
