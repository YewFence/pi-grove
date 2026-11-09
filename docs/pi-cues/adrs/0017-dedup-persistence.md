# ADR 0017: 去重状态经会话条目持久化

- 状态：已接受
- 日期：2026-11-09

## 上下文

会话级去重（ADR 0005）的实现是扩展实例闭包里的内存 `Set`。但 pi 在 `/resume`、`/new`、`/fork` 和 reload 时会**销毁并重建扩展实例**（`session_shutdown` → 重新加载 → `session_start`），进程退出后 `pi --resume` 更是全新进程。去重状态随实例蒸发，而第一次注入的 envelope 还留在会话历史（`tool_result` 附加 part 与 `nextTurn` custom_message 都持久化）——resume 后同一命令再触发一次，模型上下文里就有两份相同内容：inline/file/skill 白烧 token，exec 重跑命令，telemetry 同一 `sessionId` 记两条，`/cues status` 计数失真。

pi 自身的契约就是"内存态在 resume 时会丢，扩展在 `session_start` 重建"（extensions.md：session replacement 段）。此前 pi-cues 的 `session_start` 只做 `clearSession`，没有重建——这是遗漏而非设计。

## 决策

1. 每个命中在 `loaded` 落定后（恰好一次）以 `pi.appendEntry("pi-cues-triggered", { key, action, target, source, loaded })` 追加为 CustomEntry——不进 LLM 上下文，零 token 成本；`key` 就是去重键（`claimOnce` 时盖上，随记录持久存续）。
2. `session_start` 时用 `ctx.sessionManager.buildContextEntries()` 过滤出本扩展的条目，重建 `dedup` Set 与 `triggered` 日志。`buildContextEntries()` 是 compaction-aware 的（最新 compaction 之前的条目被剔除），与 `session_compact` 清空去重的既有语义天然对齐：注入已被 compact 掉的 cue 允许重新触发。
3. 重建对条目做形状校验（customType、字段类型、action 枚举），畸形条目与旧会话里的无关数据静默跳过。

## 备选

- **什么都不做，接受重复注入**：token 浪费与 exec 重跑是实际成本，且与"dedup 生命周期 = 内容在模型上下文中可见的生命周期"的既有设计意图矛盾。
- **在 `~/.cache` 里按 sessionId 落盘一份去重状态**：需要处理跨进程并发、缓存清理、写失败恢复，且会话文件本身就是 pi 提供的持久层，另造一份是重复。
- **resume 后扫会话历史里的 envelope 文本反推命中**：要解析注入文本还原 action/target，信封格式演进后还得兼容旧格式；CustomEntry 的结构化数据没有这个问题。

## 后果

resume/fork/reload 后去重正确恢复，`/cues status` 与 telemetry 在 resume 后保持一致（`sessionId` 在 resume 时不变）。每个命中多一条 CustomEntry 写入会话文件（约一行 JSON）；compact 后第一次 resume 会丢弃 compact 前的条目，对应 cue 按既有规则重新触发。同一进程内的 `/resume` 切换与进程重启行为一致。
