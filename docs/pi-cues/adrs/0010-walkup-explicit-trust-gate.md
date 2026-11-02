# ADR 0010: walkup 采集按显式信任决定门控

- 状态：已接受
- 日期：2026-10-14
- 取代：ADR 0007 中「读 pi 的 trust.json 自行判断」这一被否决的备选，以及「walkup AGENTS.md 与 pi 原生对齐、不算新增风险」的论证。

## 上下文

实测（pi 1.1.0）确认了两个事实：

1. pi 原生对 context files（AGENTS.md 等）无条件加载，不看 trust；用户侧的信任执行（如 strip 类扩展）会把它们从 system prompt 剥掉，但 pi-cues 的 walkup 在首次触碰文件时把同一份内容重新注入——信任门被静默旁路。这正是 ADR 0007 当年以「与 pi 原生对齐」为由不设门的先例被用户侧执行打破后的新局面。
2. `ctx.isProjectTrusted()` 的真实语义是「受保护资源是否被扣住」：无保护资源的仓库恒返回 true，**显式保存的 Do not trust 也被无视**（[pi#10947](https://github.com/earendil-works/pi/issues/10947)），且无保护资源的仓库从不触发询问、无决定可查。该 API 不能作为信任预言机。

## 决策

1. walkup 采集（builtin 与配置触发器）仅在 `trust.json` 中 cwd 或最近祖先的**非 null 决定为 true** 时运行；false 与 null（无决定）一律不采集。
2. 直接读取 `<agentDir>/trust.json`（纯 JSON path→bool），cwd 经 realpath 规范化后向上走链，读取或解析失败时 fail closed 为 null。agentDir 解析跟随 pi 的 `PI_CODING_AGENT_DIR`（与其它扩展一致），不自造环境变量。不 import pi 的 `ProjectTrustStore`：pi-cues 现有对该包的引用全部是 type-only（运行时擦除），值导入在开发工作区因 pi-codemode 导出偏斜当场崩溃、在安装态 dist 的解析路径未验证——自包含读取在 jiti 扩展、vitest、安装产物三个上下文行为一致。
3. session_start 时 notify 一次门控状态；`/cues status` 常驻显示 walk-up 信任状态。

## 备选

- **门控用 `ctx.isProjectTrusted()`**：见上下文第 2 条，语义不符。
- **运行时 import `ProjectTrustStore`**：解析上下文不可控（如上），且引入对 pi 内部存储格式的隐式耦合面反而更大。
- **只做 nearest-only 采集或忽略列表**（更早的设计讨论）：与 walkup 分层累积的原语语义冲突，被 0011 的 per-trigger exclude 以更精确的形状取代。

## 后果

无决定的新仓库不采集，`/trust` 一次解锁——安全默认，需文档说明。declined 仓库与用户侧 strip 扩展的边界终于一致。walkup 收集到的 AGENTS.md 与用户信任决定严格同步；`isProjectTrusted()` 门（ADR 0007 决策 1）保留为项目配置的冗余防线，在 0009 的位置迁移后它才真正可靠。

跟进：手写解析器是两个上游问题的规避，任一解决即可重构为官方途径——① [pi#10947](https://github.com/earendil-works/pi/issues/10947) 修复 `isProjectTrusted()` 对无保护资源仓库的语义后可改用该 API；② pi-coding-agent 与 pi-codemode 的导出偏斜（`pi-codemode/declarations` 缺 `MCP_TYPESCRIPT_PREAMBLE`，导致运行时 import 崩溃，尚未报上游）解决后可直接 import `ProjectTrustStore`。
