# ADR 0001: 中央 trigger 表取代 frontmatter 规则文件

- 状态：已接受
- 日期：2026-10-14

## 上下文

pi-rules 的配置模型是 `.pi/rules/**/*.md` 目录发现 + 每个规则文件自己的 frontmatter globs。pi-cues 的触发条件（bash 命令名、操作路径 glob）与动作（加载 skill、注入文件、walk-up）是结构共通的，分散到每个文件里反而割裂。

## 决策

配置模型是一份中央 trigger 表（`.pi/pi-cues.toml` + `~/.pi/agent/pi-cues.toml` 追加合并），条件放进 `when` 谓词子表，动作用 `action` 字段表达。pi-cues 定位为 pi-rules 的**替代**而非共存：walk-up 上下文加载作为内置 action 覆盖其实用部分，`.pi/rules` 目录发现与 frontmatter 模型不做。

## 备选

- **复用 pi-rules 的 frontmatter 模型**：条件与动作异质（命令精确匹配 vs 路径 glob vs 无条件的 walkup），塞进统一 frontmatter 需要语义模糊的 `pattern` 字段；中央表一处可审、可 diff、可版本化。
- **与 pi-rules 共存**：两套注入语义并存，模型收到来源冲突的上下文块，排障困难。

## 后果

映射表由用户维护（不自动发现 SKILL 与 CLI 的关联），保持确定性；换来的是所有触发逻辑一处可见，`/cues status` 能完整列出。
