# Architecture Decision Records

pi-cues 的关键设计决策及取舍。每个 ADR 记录上下文、决策、被否掉的备选和后果；变更决策时新开 ADR，不改历史。

| # | 决策 |
|---|---|
| [0001](0001-central-trigger-table.md) | 中央 trigger 表取代 frontmatter 规则文件 |
| [0002](0002-shell-quote-heuristics.md) | shell-quote 启发式而非 bash AST |
| [0003](0003-skill-injection.md) | skill 注入：getCommands 发现 + 自读全文 |
| [0004](0004-walkup-anchor-cwd.md) | walk-up 边界锚定 ctx.cwd |
| [0005](0005-content-addressed-dedup.md) | 按内容寻址的会话去重 |
| [0006](0006-user-bash-next-turn.md) | user_bash 经 sendMessage(nextTurn) 注入 |
| [0007](0007-trust-and-boundaries.md) | 信任门与路径边界 |
| [0008](0008-builtin-defaults.md) | 内置默认 walkup AGENTS.md |
| [0009](0009-project-config-under-extensions.md) | 项目配置迁移至 .pi/extensions/pi-cues/ |
| [0010](0010-walkup-explicit-trust-gate.md) | walkup 采集按显式信任决定门控 |
| [0011](0011-walkup-exclude.md) | walkup 按锚点相对路径的 exclude 过滤 |
| [0012](0012-injection-envelope.md) | 注入信封：`<pi-cues>` 唯一边界 |
| [0013](0013-exec-action.md) | exec 动作：运行配置命令并注入其输出 |
| [0014](0014-global-config-under-extensions.md) | 全局配置也放在 extensions 下（取代 0009 决策 2） |
| [0015](0015-command-output-block.md) | exec 输出用 `<command-output>` 块（取代 0013 决策 4） |
