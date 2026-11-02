# ADR 0003: skill 注入——getCommands 发现 + 自读全文

- 状态：已接受
- 日期：2026-10-14

## 上下文

`skill` 动作需要把目标 SKILL 送进模型上下文。候选：程序化发送 `pi.sendUserMessage("/skill:name")`；自扫 skill 目录；复用 pi 原生命令解析。

## 决策

发现沿用 pi 原生实现：`pi.getCommands()` 过滤 `source === "skill"`，命令名剥掉 `skill:` 前缀后与 target 比对，从 `sourceInfo.path` 取 SKILL.md 路径。加载自己做：读文件、剥 frontmatter、拼 pi 原生强制加载同款格式（`<skill name location>References are relative to {baseDir}.\n\n{body}</skill>`，与 pi-mention-skill 一致）。skill 正文**全文注入、不过截断预算**，对齐 `/skill:name` 语义。

## 备选

- **`sendUserMessage("/skill:name")`**：斜杠展开是 TUI/RPC **输入管道**的特性，程序化发送不保证展开——模型可能只看到字面量 `/skill:name`。否决。
- **自扫 skill 目录**：同名冲突时 target 无法消歧，且目录名可能与 SKILL.md 的 `name` 字段不同；getCommands 与 `/skill:name` 看到的是同一份解析结果，冲突按 pi「先发现者胜」规则天然消歧。

## 后果

发现与加载分离：pi 负责"哪个 skill 在哪"，pi-cues 负责"读进来按原生格式注入"。skill 与 file 动作共用注入契约，只是正文来源与截断策略不同。
