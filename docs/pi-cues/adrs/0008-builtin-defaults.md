# ADR 0008: 内置默认 walkup AGENTS.md

- 状态：已接受
- 日期：2026-10-14

## 上下文

无配置时 pi-cues 是否应该完全静默。walkup AGENTS.md 是 pi-rules 开箱即用的核心体验（子目录 AGENTS.md 在编辑其中文件时才加载；项目根那份 pi 原生已加载，由 `nativeContextPaths` 去重兜底）。要求每个配置都手写同一段样板是反常的。

## 决策

内置一条第零级默认 trigger：`tools = ["read","edit","write"]`、无 `when`、`action = "walkup"`、`target = ["AGENTS.md"]`，在全局和项目配置之前追加合并。任一配置文件写 `defaults = false` 关闭。

只含 AGENTS.md：它是社区事实标准，且 pi 原生 contextFiles 已覆盖项目根、本扩展补子目录场景。CLAUDE.md 不进默认——用户写了显式 walkup 自然会带上。

## 备选

- **无默认，纯显式配置**：配置表是唯一事实来源最纯粹，但丢掉了最主要的零配置价值。
- **隐式停用（存在用户配置就关默认）**：用户加一条无关规则就丢失 walkup，行为不可预测；显式 `defaults = false` 更可预测。

## 后果

默认项是确定性的、可在 `/cues status` 中看到（source 标 `<builtin defaults>`）。它成立的前提是按内容寻址的去重（ADR 0005）——否则默认与用户 walkup 会双注入。
