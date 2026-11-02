# @pi-grove/edit-diagnostics

为 Pi 内置 `edit` 增加匹配失败诊断。它保留原生 `edit` 的精确匹配、有限 fuzzy matching、唯一性检查、重叠检查和全有或全无写入语义；当 `oldText` 找不到时，如果文件快照中存在唯一的“仅空白不同”候选，就显示候选行号以及 JSON 转义后的期望文本和实际文本。

## 使用

```bash
pi install /path/to/pi-grove/packages/edit-diagnostics
```

临时试用：

```bash
pi -e /path/to/pi-grove/packages/edit-diagnostics
```

它会替换内置的 `edit` 工具，因此不要和其他替换 `edit` 的扩展同时加载。候选信息只用于诊断，不会自动把 tab、空格、缩进或空行视为等价，也不会在失败后写入部分修改。

唯一候选的 `Your input (oldText)` / `File content` 会完整输出为 JSON 字符串，保留 `\t` 和 `\n`，不截断多行片段。行号对应本次匹配使用的文件快照；修正失败项后应重新提交完整 `edits` 数组，因为其他项也尚未写入。没有唯一候选时，提示重新读取文件；重复匹配、重叠、文件读写失败和中止继续使用原生错误。

扩展通过原生公开的文件操作接口捕获快照，成功结果及 diff 仍由原生实现生成。执行失败后，诊断和路径标题统一显示在同一个错误框内，取代预览错误；模型收到的仍是一份工具结果。失败诊断依赖原生“找不到文本”的错误措辞；无法识别的错误原样返回。

扩展默认把失败 edit 及其后续操作记录到本地 JSONL 文件：

```
$XDG_STATE_HOME/pi-edit-diagnostics/events.jsonl
```

`XDG_STATE_HOME` 未设置或不是绝对路径时用 `~/.local/state`。规则很简单：一次 `edit` 失败后开始记录，随后最多记录 5 次 `read / edit / write`；其他工具忽略，也不占次数。窗口内 `edit` 再次失败，就从这次失败起重新观察后面 5 次。成功的 edit 或整个文件的 write 不会提前关闭窗口。

每次操作完成后写一条，包含时间、session、模型、工具名、调用 id、成功/失败、关联的失败 edit id 和窗口内序号；失败 edit 还标记是否带有本扩展诊断。`input` 完整保留本次工具参数，包括路径、read 的范围参数、edit 的整个 `edits` 数组（`oldText` / `newText`）以及 write 的 `content`，不截断、不脱敏，方便在 PoC 阶段检查模型具体反复犯了什么错误。多行文本、tab 和引号由 JSON 转义保存，解析后可还原。记录仅保留在本机，写入失败不影响工具执行，session 关闭时等待缓冲写完。文件不自动轮转，观察窗口也不跨重载或 session 切换恢复。

## 开发

在 monorepo 根目录运行：

```bash
mise run check
mise run test
```

只运行本包测试：

```bash
node --test packages/edit-diagnostics/test/
```
