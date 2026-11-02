# ADR 0014: 全局配置也放在 extensions 下，与项目级同形

- 状态：已接受（取代 ADR 0009 决策 2）
- 日期：2026-10-23

## 上下文

ADR 0009 把项目配置搬进 `<cwd>/.pi/extensions/pi-cues/config.toml`（信任绑定），同时保留全局配置在 `~/.pi/agent/pi-cues.toml`，理由是「位置的不对称就是设计：项目配置需要 trust 绑定，全局配置是用户自己的」。

不对称的代价落在使用者身上：两级配置是同一份 schema、同一套 trigger 语义、同一句「追加合并」，却要在两个形状完全不同的路径上找文件。写全局配置时得记住 `~/.pi/agent/` 下是扁平文件，写项目配置时得记住 `.pi/extensions/pi-cues/` 下是嵌套目录；引用 `file` target 的相对路径基准也跟着换。信任语义已经由「配置在哪一级」表达（全局永远加载、项目按信任加载），不需要再用路径形状重复编码一次。

技术上没有阻碍：pi 的扩展发现（`discoverExtensionsInDir` → `resolveExtensionEntries`）对 `extensions/*` 子目录只认 `package.json` 的 `pi.extensions` 或 `index.ts`/`index.js`，只含 `config.toml` 的目录被静默跳过——项目级已验证同一行为（ADR 0009），全局级用的是同一段发现代码。

## 决策

1. 全局配置路径改为 `~/.pi/agent/extensions/pi-cues/config.toml`：与项目级共用相对路径 `extensions/pi-cues/config.toml`，只有根不同（项目的 `.pi/` 与 pi 的全局 agent 目录）。代码里收敛为一个常量，不再按 scope 分支拼路径。
2. 旧的 `~/.pi/agent/pi-cues.toml` 不再被识别，与项目级旧位置同等处理：静默忽略、不记 diagnostic。
3. 项目级的信任门、`file` target 不得逃逸配置目录等边界一律不变——位置统一不改变两级在**加载条件**上的差异。

## 备选

- **维持 ADR 0009 的不对称**：被否。省下的只是「多一层目录」，代价是使用者每次都要记两套路径，且不对称没有任何功能性收益——信任差异由加载条件表达，不由路径表达。
- **全局位置加回退读旧路径 + 弃用 diagnostic**：被否。项目级旧位置是静默忽略（ADR 0009 决策 1），全局级加诊断就成了新的不对称；项目还在早期，不做兼容层。
- **全局配置也要求 trust 绑定**：被否。全局配置是机器主人的，没有第三方写入者，trust 绑定无处落地。

## 后果

- 两级配置形状一致：`<root>/extensions/pi-cues/config.toml`，`file` target 的相对基准在两级都是 `…/extensions/pi-cues/`。
- 已存在的全局配置需要手动搬到新路径；不搬则视为没有全局配置（静默）。
- 全局 `extensions/` 目录多出一个只含 `config.toml` 的 `pi-cues/` 子目录，pi 的扩展发现静默跳过它，不会误加载。
