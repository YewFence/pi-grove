# ADR 0002: shell-quote 启发式而非 bash AST

- 状态：已接受
- 日期：2026-10-14

## 上下文

bash 管道需要从命令串提取命令名。候选：完整 bash AST（tree-sitter-bash + WASM）、停更的 bash-parser、零依赖的 shell-quote。

## 决策

用 shell-quote 拆词，按 `|`/`||`/`&&`/`;` 切分简单命令，剥环境赋值前缀与一层已知包装器（硬编码：sudo/env/npx/bunx/uv run/mise x/mise run），取 basename。非目标：命令替换、heredoc、函数定义内的调用一律尽力而为。

## 备选

- **tree-sitter-bash**：真 AST 遍历 `command_name` 节点，精度最高，但引入 WASM 依赖与初始化成本。留作逃生舱：启发式误报/漏报率不可接受时升级，接口不变。
- **bash-parser (vorpaljs)**：2022 年停更，排除。

## 后果

spike（`scripts/spike-shell-quote.mjs`，已验证后删除）确认三个关键形状：赋值是纯字符串 token；重定向 op（`>`、`<<`）**不能**当分隔符，否则 `jj log > out.txt` 的 `out.txt` 被误当命令；`$(...)` 内容落在 paren op 之间、深度跟踪跳过。`parse()` 几乎不抛异常，"解析失败静默放弃"是防御性分支。已知盲区：`xargs -I{} jj ...` 这类执行器不剥、`sudo -u root jj` 会把 `root` 误当命令——可接受。
