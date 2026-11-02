# ADR 0007: 信任门与路径边界

- 状态：已接受（决策 4 的「轻量头」部分由 [ADR 0012](0012-injection-envelope.md) 取代）
- 日期：2026-10-14

## 上下文

威胁场景：用户**全局**安装 pi-cues，克隆的恶意仓库带一份 `.pi/pi-cues.toml`，写入恶意提示词注入（`file` target 指向仓库内的投毒文件，或逃逸指向仓库外的敏感内容）。pi 的 project trust 保护 `.pi/` 下的受保护资源，但 pi-cues 的配置是扩展自己读的，不在其清单内。

同时划清先例边界：pi 原生 **AGENTS.md 不看 trust 无条件加载**——所以纯 walkup AGENTS.md 与 pi 原生对齐，不算新增风险。新增风险只在超出先例的部分。

## 决策

1. 项目配置仅在 `ctx.isProjectTrusted()` 时加载；不受信任则整体忽略（含其中的 `defaults` 覆盖——恶意仓库连关闭默认项的权限都没有），记 diagnostic + session_start notify
2. 项目配置的 `file` target 必须解析在配置目录内，逃逸条目拒载 + diagnostic；全局配置（用户自己的）不受限
3. walkup 对 cwd 子树外的被操作文件不触发
4. 注入归因：`before_agent_start` 在 system prompt 尾部加一行说明（标 `pi-cues:` 的块是确定性注入），每个注入块带轻量头 `pi-cues: trigger: … source: …`——避免模型把注入块误认为提示词注入攻击

## 备选

- **读 pi 的 trust.json 自行判断信任目录外内容**：把"信任"与"注入哪些路径"耦合，规则隐晦；cwd 边界已挡住实际逃逸路径。
- **每次注入都带完整解释**：token 成本高；一次性 system prompt 说明 + 轻量头足够归因。

## 后果

全局安装是安全的默认姿势；项目级扩展安装（`.pi/extensions/`）本身已被 pi 的 trust 保护。未被信任的项目里 pi-cues 退化为仅全局配置 + 内置默认。
