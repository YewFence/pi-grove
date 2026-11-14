# ADR 0018: policy 维度——once / repeat / confirm 取代 action 里的 confirm

- 状态：已接受
- 日期：2026-11-27

## 上下文

pi-cues 的每个 target 每会话至多触发一次（ADR 0005 的内容寻址去重）。这适合「加载一次就常驻」的上下文（skill、conventions 文件），但有一类提示的价值恰恰在重复：`jj` 每次触发都重申一句提交规范，`exec` 每次都重拉当前子命令的 `--help`。会话拉长后，一次注入的提醒会被上下文窗口冲淡，需要 repeat。

要加 repeat 时暴露了一个构型问题：`confirm` 当时是第六个 action（ADR 0016），但 action 实际同时在回答两件事——target 怎么物化成文本（skill/file/walkup/inline/exec 五种），以及触发后怎么处置（注入一次 / 每次注入 / 事前拦截一次）。只有一个处置维度时塞进 action 枚举是最小改动；repeat 一出现，两个维度就缠不清理还乱了。

## 决策

把处置方式拆成独立的 `policy` 字段，`action = "confirm"` 移除：

- `policy = "once"`（默认）：维持现状，每会话首次匹配注入，内容寻址去重。
- `policy = "repeat"`：每次匹配都注入。首次触发照常 claim 去重键并持久化 session entry（ADR 0017 的 resume 重建因此不区分策略，共享同一 target 的 once 触发器 resume 后也不会多注入一遍）；后续触发绕过检查、不写 entry，toast 每次都发并带 `(repeat)` 标记，telemetry 每次都记。`exec × repeat` 每次匹配都重跑命令。walkup 不允许 repeat——它按收集文件的 realPath 跨触发器扁平去重（ADR 0005），逐事件重注入无意义。
- `policy = "confirm"`：事前拦截（原 confirm action），第一版只配 `action = "inline"`，等价迁移。

组合约束由校验兜底：`confirm` 只配 `inline`、walkup 只支持 `once`、`confirm` 单 target。**「事前每次都拦」在配置语法里写不出来**——枚举只有三个值，这个组合没有对应的可实现语义（重试会被同一个 reason 再拦，软锁死循环）。

信封 `action` 属性、session entry、telemetry、`/cues status` 的动作名仍是六值 `ActionKind`（含内部 `confirm`）：模型可见的一切不变，resume 兼容零成本。

存量 `action = "confirm"` 硬切：解析报 warning 并给出迁移指向（`action = "inline"` + `policy = "confirm"`）。项目处于早期、用户基本只有作者本人，不留别名过渡层。

## 备选

- **repeat 布尔字段**：`repeat = true` 加在触发器上，confirm 保持第六个 action。改动最小，但 `confirm × repeat` 这个不可实现组合得靠校验去堵，而且「confirm 其实是处置方式不是物化方式」的构型扭曲保留了下来。
- **全局 `[repeat]` 表**（类似 `[confirm] template`）：粒度太粗，一条想重复的 inline 提醒会连带所有 skill/file 注入一起重复。
- **支持 confirm × repeat（每次拦截）**：需要「重试豁免」机制（识别刚被 block 过的同一调用），pi 的 tool_call 事件没有可靠标识可用，工程量大且语义危险，否决。
- **别名兼容一版**：`action = "confirm"` 静默映射为新写法。多一层过渡逻辑换不来什么——没有外部用户。

## 后果

- 配置的心智模型变成两个正交问题：action 问「注入什么形态」，policy 问「何时注入、注入几次」。
- repeat 的每次注入都占上下文窗口：高频触发器（每条 bash 命令都匹配）配长提示会明显吃预算。写文档时提醒：repeat 适合一句话提示或 `exec --help` 这类短输出。
- `file + confirm`、`skill + confirm`（拦截理由放文件/skill 里）是天然的后继扩展，等真实需求出现再开。
- ADR 0016 的「confirm 是第六个 action」表述被本 ADR 取代；0016 的拦截机制、模板语义、单 target 约束全部保留。
