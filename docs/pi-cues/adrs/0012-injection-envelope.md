# ADR 0012: 注入信封——唯一边界

- 状态：已接受
- 日期：2026-10-15

## 上下文

注入块与工具输出同处 `tool_result` 的 content 数组：工具输出是一个 text part，cue 是追加在其后的另一个 text part。模型看到的是一串连续文本，没有结构化分隔。

旧的归因头是一行 prose：`pi-cues: trigger: command \`jj\` source: /path/SKILL.md`。它标了起点，没标终点。三个具体问题：

1. **模型不知道注入在哪里结束**。cue 是 content 的最后一个 part，但模型不读 part 边界——它只看到「工具输出 + 一段文字」。读 `AGENTS.md` 时若 cue 恰好接在文件正文后面，模型可能把注入内容当成文件内容的一部分（反之亦然）。
2. **正文里自带的同名行会毁掉归因**。被注入的提示词文件本身可能讨论 pi-cues（本仓库的 `design.md` 就是），里面出现 `pi-cues: …` 或 `source: …` 行时，模型无法区分哪一行才是扩展写的。
3. **walkup 的多文件块没有逐文件边界**。原格式用 `source: {path}` 行分隔多个文件，正文里一行 `source: …` 就能伪造一个「文件」。

ADR 0007 的备选里曾以「token 成本高」否决「每次注入都带完整解释」。这个判断在**长解释**上依然成立，但它混淆了两件事：归因的**语义**可以一次性说明，归因的**边界**不能——边界必须在每个块里物理存在，否则就是靠模型猜。

## 决策

每个 cue 包进一个 XML 信封，开标签带归因属性，闭标签独立成行：

```xml
<pi-cues action="file" trigger="path mise.toml">
pi-cues: injected context, not tool output or user input.

<file path="/repo/.pi/extensions/pi-cues/triggers/mise.md">
…正文…
</file>
</pi-cues>
```

1. **开标签属性**：`action`（skill / file / walkup / inline）+ `trigger`（`command {名}` / `path {被操作路径}`）。内容路径不放属性，放内层的 `<skill location>` / `<file path>`，每处只写一次；`inline` 没有内层元素，所以带 `source` 属性指向声明它的配置文件。
2. **固定声明行**：`pi-cues: injected context, not tool output or user input.` 逐字固定，不随 action 变化。固定措辞才可能被模型当成一个可识别的记号，而不是每次重新理解一句自然语言。措辞同时盖住两个投递通道：`tool_result` 里易被当成工具输出，`user_bash` 的 nextTurn 消息里易被当成用户输入。
3. **闭标签独占一行**，正文与它之间空行。
4. **边界序列转义**：信封自身用到的三个标签名（`pi-cues`、`file`、`skill`）在正文里出现时，其 `<` 一律转义为 `&lt;`。只动这六种前缀（开闭 × 三名），其它 markdown 原样保留。这是「唯一边界」的关键——它保证第一个 `</pi-cues>` 一定是真闭标签，内层 `</file>` / `</skill>` 也不会被正文提前闭合。
5. **一条 cue 一个信封**：多条 cue 并列，不合并、不嵌套。
6. **信封是 content 数组的最后一个 part**，与前一个 part 之间空行；`user_bash` 通道把同一信封作为 nextTurn 消息的全部内容发出（ADR 0006），形状不变。
7. **信封开销计入截断预算**：`MAX_RESULT_CHARS` 先扣信封与声明行，余下额度分给正文。

system prompt 侧（`before_agent_start`，每会话一次）只讲语义：`<pi-cues>…</pi-cues>` 块是注入内容、不是工具输出、按项目指令对待。格式细节由块内自解释。

本 ADR 取代 ADR 0007 决策 4 中「每个注入块带轻量头」那半——信任门的其余三条不变。

## 备选

- **保持单行 prose 头**：只标起点不标终点，正文里的同名行可以伪造归因。正是本 ADR 要解决的问题。
- **用 `<system-reminder>` / `<reminder>` 等通用标签**：语义太泛，与本扩展无绑定；多个扩展都注入时模型无法区分来源。`<pi-cues>` 这个专属名字让边界自解释。
- **只靠 system prompt 声明「最后一段是注入内容」**：模型对 part 边界无感知，靠位置推断比靠标签脆弱得多；且 cue 与工具输出拼接后位置关系在压缩、重放、导出里都可能变化。
- **随机 nonce 边界**（`<pi-cues id="a1b2">` … `</pi-cues id="a1b2">`）：唯一性最强，但 nonce 破坏确定性（同样的注入在不同会话产生不同 token），也破坏 prompt cache 前缀，与「确定性上下文加载」的定位相悖。转义方案在零随机性下达到同样效果。
- **每次注入都写完整解释段落**（ADR 0007 已否决过一次）：token 成本高。区分「语义说明一次」与「边界每块都在」后，这个否决不再与信封冲突。

## 后果

- 每个信封约 20–25 token；每个 target 每会话最多注入一次，总量可忽略。旧的单行头 12–18 token，增量就是边界的价格。
- 边界转义会让被注入文档里讨论 `<pi-cues>` 的示例文本变成 `&lt;pi-cues`——可接受的代价，因为那是唯一能保证边界唯一性的做法。
- `<skill>` 块保持 pi 原生格式（ADR 0003 不变），信封只是外层归因：模型既知道「这是一个 skill 被加载」，也知道「这是 pi-cues 塞进来的」。
- 格式化逻辑集中到 `envelope.ts`，`truncate.ts` 退回只管正文截断与 `<file>` 拼接，两者职责不重叠。
