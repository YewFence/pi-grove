# ADR 0011: walkup exclude

- 状态：已接受
- 日期：2026-10-14

## 上下文

walkup 的语义是分层累积：触碰 `stacks/yewyard/agent-vault/compose.yaml` 时收集服务 README、池级 README、根 README 整条链。起源于 services 仓库的用例：希望注入各服务自己的 README，但根 README 是人类落地页（约 130 行），与 stack 任务基本无关，被整链拖入是纯噪声。

## 决策

1. walkup 触发器新增 `exclude`（字符串或数组）：picomatch pattern，匹配**采集到的文件相对 session cwd 的 POSIX 路径**。`"README.md"` 只匹配 cwd 层那份；任意深度用 globstar pattern。
2. `!` 前缀在配置校验阶段直接拒绝——负空间语义留给 `when.path`，exclude 保持纯正向匹配，避免两套取反规则。
3. 过滤发生在 `collectContextFiles` 返回之后：共享的 walkup 缓存不感知 exclude，多个触发器各筛各的。

## 备选

- **gitignore 式解析器**：为一个用例引入新依赖和第二套 pattern 语义；picomatch 已在匹配管线中。
- **整个锚点层不采集**：锚点层的 `CONTEXT.md`（领域语言文档）是合法的 walkup target，一刀切会误杀；锚点层 AGENTS.md 本就靠 native dedup 跳过，无需处理。

## 后果

根 README 排除变成一行配置；exclude 是 per-trigger 的——被触发器 A 排除的文件仍可被触发器 B 采集，语义彼此独立。
