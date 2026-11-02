# ADR 0015: exec 输出用 `<command-output>` 块，不再借用 `<file>`

- 状态：已接受（取代 ADR 0013 决策 4 的「`<file path>` 块显示命令本身」）
- 日期：2026-10-23

## 上下文

ADR 0013 落地时，exec 输出直接复用了 `formatFileBlock`：输出包在 `<file path="jj edit --help">` 里，`path` 属性装的是命令行。这让 exec 免费获得了截断预算与边界转义，但语义是错的，且有一个实际误导：

1. **内容种类错位**。信封的内层元素一向是「内容种类 + 出处属性」——`<file path>` 是文件、`<skill name>` 是技能。命令输出不是文件，套 `<file>` 等于向模型谎报内容种类。
2. **截断提示指向不存在的操作**。`<file>` 的截断提示是 `[Content truncated. Read full file: {path}]`，exec 输出截断后会渲染成「Read full file: jj edit --help」——模型可能真去读一个叫这名字的文件，而不是重跑命令拿到完整输出。cue 的会话去重只管注入，不拦模型自己重跑，所以「重跑」是真实可执行的补救路径。

## 决策

1. exec 输出改用专用的 `<command-output command="…">` 块，命令行装在 `command` 属性上，形状与 `<file path>` / `<skill name>` 同构（内容种类 + 出处属性）。
2. 标签风格取 kebab-case，与信封根标签 `pi-cues` 一致；这是仓库内多词标签的第一个先例，后续内层标签沿用。
3. `<command-output>` 加入信封边界标签集：命令输出里出现字面 `<command-output` / `</command-output` 时同样转义成 `&lt;`，维持 ADR 0012「第一个 `</pi-cues>` 是唯一真闭标签」的保证。现在被转义的前缀是八种。
4. 截断提示换为 `[Output truncated. Re-run the command to see the rest.]`，不含任何路径占位符。
5. 截断预算规则不变：`MAX_RESULT_CHARS` 扣信封开销、`MAX_FILE_CHARS` 封顶单块正文；多文件拼接语义不适用于 exec（单命令单输出），新函数不保留该逻辑。

## 备选

- **继续用 `<file path>`（维持 0013 原样）**：被否。省一个函数，代价是内容种类撒谎加截断提示误导，且 `<command-output>` 的边界转义本来就要做。
- **snake_case 的 `<command_output>`**：被否。仓库信封标签是 kebab-case（`pi-cues`），统一成一种风格。
- **`<command name="…">`**：被否。标签叫 command、属性再叫 command（或用 `name` 装整条命令行）自相矛盾；「某条命令的输出」读 `<command-output command>` 一眼自明。
- **`<output command="…">`**：被否。单看标签不自明，`output` 在上下文里太泛。

## 后果

- exec 信封内层元素语义正确；截断后模型看到的补救动作（重跑命令）真实可执行。
- `escapeEnvelopeTags` 多转义一种前缀，正文里八种前缀被转义；对其它 markdown 仍逐字节不动。
- 已注入过的旧格式 `<file path="…">` 不做迁移：注入是会话级的一次性事件，下个会话自然使用新格式。
