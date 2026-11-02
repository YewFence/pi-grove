# ADR 0009: 项目配置迁移至 .pi/extensions/pi-cues/config.toml

- 状态：已接受（决策 2「全局级保持 `~/.pi/agent/pi-cues.toml`」已被 [ADR 0014](0014-global-config-under-extensions.md) 取代；决策 1、3 仍然有效）
- 日期：2026-10-14

## 上下文

威胁场景（继承 ADR 0007）：用户全局安装 pi-cues，克隆的仓库带一份项目配置写入恶意提示词注入。原位置 `.pi/pi-cues.toml` 不在 pi 的 trust 保护资源清单内（清单只认 `.pi/` 下 settings.json、mcp.json、extensions、skills、prompts、themes、SYSTEM.md、APPEND_SYSTEM.md 八个名字，以及祖先链上的 `.agents/skills`）——只带 pi-cues 配置的仓库永远不触发 trust 询问，用户连拒绝的机会都没有，pi-cues 只能靠自读 `ctx.isProjectTrusted()` 补门，而该 API 对无保护资源仓库恒真（见 ADR 0010）。

`.pi/extensions/` 目录**本身**就是保护资源：它存在即触发信任判定。pi 的扩展发现器对只含 `config.toml` 的子目录静默跳过（只认 `package.json` 带 `pi` 字段或 `index.ts/js`），不会误加载或报错。

## 决策

1. 项目级配置只从 `<cwd>/.pi/extensions/pi-cues/config.toml` 读取；`.pi/pi-cues.toml` 不再被识别（无诊断，静默忽略）。
2. 全局级保持 `~/.pi/agent/pi-cues.toml`。位置的不对称就是设计：项目配置需要 trust 绑定，全局配置是用户自己的、无需绑定。
3. `file` target 仍相对配置目录解析且不得逃逸——配置目录随位置变为 `.pi/extensions/pi-cues/`。

## 备选

- **保留 `.pi/pi-cues.toml` 并继续靠自读 API 门控**：门本身不可靠（0010），且用户无机会知情拒绝。
- **两级统一用 nested 位置**：全局配置无 trust 需求，统一位置抹掉了位置差异的含义，还把用户全局配置塞进扩展目录。

## 后果

配置存在 → 项目自动变成 trust-requiring → pi 主动询问 → 决定落盘 → `isProjectTrusted()` 走 resolve 流程变得可靠，pi-cues 的项目配置门从「自欺欺人」变成「真门」。存量项目需要迁移：配置文件与被引用的 file targets 整体移入 `.pi/extensions/pi-cues/`。
