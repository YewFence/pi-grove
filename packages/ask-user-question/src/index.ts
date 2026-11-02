import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import { registerAskUserQuestionReconciler } from "./reconcile.js";

export {
  ASK_USER_BLOCKED_EVENT,
  ASK_USER_PROMPT_EVENT,
  type AskUserBlockedEventPayload,
  type AskUserPromptEventPayload,
  type AskUserPromptOption,
  type AskUserPromptQuestion,
} from "./events.js";

export default function (pi: ExtensionAPI) {
  registerAskUserQuestionTool(pi);
  registerAskUserQuestionReconciler(pi);
}
