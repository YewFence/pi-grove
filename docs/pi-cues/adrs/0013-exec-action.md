# ADR 0013: exec 动作——运行配置命令并注入其输出

- 状态：已接受（输出块形状已被 ADR 0015 取代）
- 日期：2026-10-21

## 上下文

触发器目前的 payload 都是静态的：inline 的字面文本、file 的提示文件、skill 的全文。但有一类上下文天然是**命令输出**——比如 `jj edit --help` 的用法摘要、`git status` 式的仓库状态。这类内容写死在配置里会腐烂；让模型自己去跑又不可靠（它可能不跑，或跑错命令）。需要一个新 action：`exec`，把 target 当作 shell 命令运行，把输出注入信封。

两个约束：

1. **信封必须和触发它的工具结果同时到达**。help 文本只有在模型准备下一步动作时在场才有用；迟到一轮就只能事后补救。pi 的 `ExtensionHandler` 返回 `Promise<R | void> | R | void` 且 `emitToolResult` 会 `await` 它，所以 `tool_result` handler 可以 async——exec 直接在 handler 内等待子进程，信封作为尾部 part 追加进当次工具结果（`user_bash` 没有内容通道，仍走 nextTurn，见 ADR 0006）。
2. **任意命令执行**。target 是字面 shell 命令，配置者可以写任何东西。这正好落在 pi-cues 已有的信任模型上：项目配置只在项目被信任时加载（ADR 0007/0009），全局配置是用户自己的。exec 不需要也不应该有比 file 更宽的门控。

## 决策

新增 `action = "exec"`：

- **target 是字面命令行**，经 pi 的 `createLocalBashOperations()` 在与 bash 工具相同的 shell、cwd 与环境中执行。**不做占位符插值**（没有 `{command}` 之类）：插值引入注入面且没有实际需求。
- **仅 bash 触发器可用**，且必须带 `when.command`；path 事件对它没有意义。
- **在 handler 内等待子进程**：命令跑完、信封组装好之后 handler 才返回，信封因此和 `jj log` 自己的输出出现在同一条工具结果里。代价是这次工具调用会变慢，耗时取 exec 命令与真实工具两者中较久的那个——所以 target 应当是 `--help` 这类亚秒级命令，不该指向跑很久的东西。
- 输出经 `formatFileBlock` 截断（沿用 `MAX_RESULT_CHARS` / `MAX_FILE_CHARS` 预算）并包进信封，`<file path>` 块显示命令本身；边界转义复用 ADR 0012 的机制，命令输出里的 `</pi-cues>` 无法伪造边界。**（截断与转义机制沿袭，但 `<file>` 块形状已被 ADR 0015 取代：exec 输出现在用 `<command-output command>` 块，截断提示改指「重跑命令」。）**
- **失败降级为诊断**：非零退出且无输出、超时（10 秒）或模块加载失败时，记诊断、发 toast，不注入任何东西。
- 去重沿用内容寻址（ADR 0005）：键是命令文本本身，同一条命令每会话最多跑一次。
- `createLocalBashOperations` 只做静态 `import type` + 动态 `import()` 惰性解析：pi 1.1 的包根会急切加载 codemode，后者在某些依赖解析下因缺 `MCP_TYPESCRIPT_PREAMBLE` 而无法导入；静态 import 会在那些环境里杀死整个扩展，惰性加载则把失败范围限制在 exec 这一个 action 上。

## 备选

- **占位符插值（`jj {command} --help`）**：被否决。命令名来自 shell-quote 提取的 basename，虽无路径与参数，但任何插值都扩大注入面；当前需求全是静态命令。
- **`sendMessage(deliverAs: "nextTurn")` 异步投递**：被否决。nextTurn 消息只在用户下一次输入时才注入，help 文本会与触发它的那次调用完全脱节。
- **复用 `ctx.executeTool("bash", …)`**：被否决。它会走完整的 tool_call/tool_result 事件链，可能递归触发 pi-cues 自己；直接调 `BashOperations` 更干净。
- **不截断输出**：被否决。`--help` 类输出通常不大，但配置者可能指向任何命令；不设预算会让一条 cue 吃掉整段上下文。

## 后果

- 配置者获得「命令输出即上下文」的能力，典型用法：`jj edit --help`、`git log --oneline -5`、项目自己的状态脚本。
- 安全性依赖既有信任门：不受信任的项目的 exec 配置根本不会加载。命令以用户身份在用户 shell 里跑，与 bash 工具同级——这既是能力也是风险，文档必须明说。
- 一次工具调用被 exec 命令拖长的上限由 `EXEC_TIMEOUT_MS`（10 秒）兜住。这是能力本身的代价：要「当期 help 就在手边」，就得等它跑完。
