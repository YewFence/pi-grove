# ADR 0006: user_bash 经 sendMessage(nextTurn) 注入

- 状态：已接受
- 日期：2026-10-14

## 上下文

用户手动跑的 `!cmd` 也是线索（`!jj log` 应加载 jj-cli SKILL）。但 `UserBashEventResult` 只有 `{operations}` / `{result}` 两个**接管执行**的分支，没有附加内容的通道；返回 `undefined` 就是纯观察。且事件在命令执行**前**触发，立即发消息会打断进行中的 agent turn。另外 handler 抛异常会阻断用户命令。

## 决策

user_bash handler 命中后不立即注入：用 `pi.sendMessage({ customType: "pi-cues", display: false }, { deliverAs: "nextTurn" })` 排入下一次模型请求。handler 全部逻辑包 try/catch，永不抛出，永远返回 `undefined`。`!!` 前缀（`excludeFromContext`，命令不进上下文）不触发——命令不可见时注入的 cue 是无源之水。

## 备选

- **砍掉 user_bash**：契约最简，但丢失"用户手动跑命令也是线索"的场景。
- **`sendUserMessage`**：总会触发新 turn，可能打断或抢占当前执行；`deliverAs: "nextTurn"` 的 sendMessage 正是为此设计的延迟通道。

## 后果

两条 bash 管道共享提取/匹配/去重状态机，仅注入出口不同：tool_result 走 content 数组追加（与工具结果相邻），user_bash 走 nextTurn 消息。后者在 transcript 中不可见（`display: false`），由 `/cues status` 兜底可查。
