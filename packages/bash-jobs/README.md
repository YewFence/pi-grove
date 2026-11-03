# @pi-grove/bash-jobs

给 pi 的内置 `bash` 工具加上"超时续跑"：命令等了一会儿还没结束时,不再阻塞到结束或被杀,而是先把已有输出返回给模型,进程转入后台继续跑,模型之后用 `bash_wait` 取回后续输出。

## 定位

兜底，不是正式的后台任务方案:解决的是模型把 `timeout` 设得过短、或同步等待卡住的情况;刻意要把命令放到后台，模型直接 `nohup` 就够了。

- 不改变模型习惯:参数还是 `command` 和 `timeout`，没有 `background: true` 之类的新概念;`timeout` 从「到点杀」变成「到点让出」，不会再出现「超时写短了 → 被杀 → 重试又写短」的循环。
- 够轻:用同名工具替换内置 `bash`，执行、截断、临时文件和渲染全部复用，快路径与内置完全一致，其他扩展挂在 `bash` 上的 `tool_call` / `tool_result` 钩子照常生效。
- 代价:与其他替换 `bash` 的扩展互斥，见「使用」。

社区里正式做 background-bash 的插件已有几个，完整对比见 [ecosystem.md](ecosystem.md)。

## 使用

```bash
pi install /path/to/pi-grove/packages/bash-jobs
```

本地路径只写进 settings,不会复制,pi 直接加载本包目录的源码。从 monorepo 根目录临时试用可以用 `pi -e ./packages/bash-jobs/src/index.ts`。不要与其他替换 `bash` 的扩展同时使用：pi-codex-conversion 的 Structured 模式会让模型同时看到 `exec_command` 和 `bash` 两套 shell 工具，pi-background-bash 则整体接管 `bash` 执行。

## 行为

### `bash`

- 到达 `timeout` 指定的时间仍未结束时,返回已有输出和转后台提示(含可直接使用的 `job_id` 与 `bash_wait`/`bash_kill` 调用写法),进程在后台继续跑。`timeout` 会被足额等待,期间命令静默不会提前转后台;超过 30 分钟的 `timeout` 按 30 分钟封顶。
- 未设置 `timeout` 时,命令连续 15 秒没有新输出,或累计跑满 30 分钟仍未结束,同样转后台,防止无限阻塞前台。
- 审批等待不计入 TUI 的 `Elapsed` / `Took`：进入实际执行后才开始计时；审批被拒绝时不显示执行耗时。
- 在此之前结束的命令,结果与内置 `bash` 完全一致:非零退出码抛错,超长输出截尾并落盘。
- `timeout` 现在表示"等多久后转入后台",不再杀进程。转入后台后进程继续运行,要终止只能用 `bash_kill`。
- 转入后台前按 Esc 会杀掉进程;转入后台后 Esc 不影响 job。

### `bash_wait(job_id, seconds?)`

- 返回该 job 自上次读取以来的新输出;进程退出时提前返回。
- 退出码 0 正常返回;非零退出、执行失败抛错,与 `bash` 一致。
- 对仍在运行的 job,每次等待至少 30 秒,之后每次翻倍(上限 30 分钟),防止模型频繁轮询。此策略只在宿主端执行,不写入提示词。
- 单次返回按内置限制截尾(2000 行或 50KB);转入后台后的完整输出写在临时日志文件中,截断时给出路径。
- 取回终态结果后 job 即被移除,再次查询会报 `Unknown job`。
- 等待中按 Esc 只中断这次等待,job 继续运行。

### `bash_kill(job_id)`

- 终止一个后台 job 并返回其剩余输出。
- 如果 job 已经结束但结果还没被取回,返回其最终结果(非零退出照样抛错),然后移除该 job。

session 关闭时会杀掉所有仍在运行的 job。

### 环境刷新(source hooks)

Source hook 是一个产出 bash 初始化代码的命令。在每次模型调用 `bash` 前,bash-jobs 执行配置中的 hook,把成功命令的 stdout 放到实际 bash 命令前执行,让长时间运行的会话跟上环境配置变化。没有配置文件时不执行任何 hook,也不内置特定环境管理工具。

配置文件位于 `~/.pi/agent/extensions/pi-bash-jobs/config.toml`;设置 `PI_CODING_AGENT_DIR` 时,改为该目录下的 `extensions/pi-bash-jobs/config.toml`。只读取用户全局配置,不读取项目配置。会话启动时加载,编辑后执行 `/reload` 重新加载。

例如,使用 mise 刷新环境:

```toml
version = 1

[[source_hooks]]
name = "mise"
command = ["mise", "hook-env", "-s", "bash", "--force"]
timeout_ms = 3000
quiet = false
report_stderr_on_success = true
```

`command` 是非空参数数组,直接启动进程,不经过 shell 展开。`timeout_ms` 可选,默认 3000,必须是 1 到 2147483647 之间的整数。hook 在本次 bash 的工作目录中执行,继承 bash 的初始环境。需要 shell 语法时显式调用 `bash -c`,复杂逻辑可以写成独立脚本。脚本向 stdout 输出 `export`、`unset` 等 bash 代码;stderr 按成功与失败各自的配置报告,最多捕获 8 KiB。相对脚本路径按本次工作目录解析,跨项目使用的脚本建议写绝对路径。

可以按需追加 direnv 或自己的脚本:

```toml
[[source_hooks]]
name = "direnv"
command = ["direnv", "export", "bash"]

[[source_hooks]]
name = "custom-env"
command = ["/absolute/path/to/agent-env"]
timeout_ms = 5000
```

多个 hook 按声明顺序执行,随后在同一个 bash 中按顺序应用生成的代码,后面的赋值可以覆盖前面的。生成代码的进程彼此不继承前一个 hook 的环境修改;有初始化依赖时把步骤放在同一个脚本中。

hook 非零退出、命令缺失、超时或 stdout 超过 1 MiB 时,该 hook 生成的初始化代码被丢弃,其他 hook 和实际 bash 命令继续执行。`quiet` 默认为 `false`:每次失败都会向模型报告原因和最多 8 KiB 的 stderr,不额外弹失败或恢复通知。设置 `quiet = true` 则不向模型输出该 hook 的错误,仅在首次失败和恢复时各通知用户一次。两种模式都会在下次调用时重试,取消不计作 hook 故障。

`report_stderr_on_success` 默认为 `true`,独立于 `quiet`:hook 以退出码 0 完成但 stderr 非空时,向模型报告 `outcome="warning"` 的 envelope,stdout 初始化代码照常继续执行。设置为 `false` 则隐藏成功时的 stderr,不影响失败报告。扩展保留 stderr 内容,用户可用包装脚本清洗不需要的输出。

错误使用独立的 `<pi-bash-jobs action="source-hook" hook="…" outcome="failed">` envelope,stderr 包在内层 `<command-output stream="stderr">` 中。每块最多 8192 字符,包含标签开销,超出部分截断并保留完整闭标签;外部输出中的边界标签会转义。诊断与实际命令输出分开投递,命令成功或失败仍由实际执行结果决定。命令转后台后才出现的 hook 错误会随 `bash_wait` 或 `bash_kill` 返回。

正常执行不增加系统提示。每个 session 首次向模型报告错误时,在 envelope 内补充一句来源说明:

> pi-bash-jobs: an environment preparation hook failed. Its environment update was skipped; the requested command still runs. The following block contains the hook’s error output.

成功但有 stderr 时使用单独的来源说明:

> pi-bash-jobs: an environment preparation hook succeeded and wrote to stderr. Its generated initialization code will run before the requested command. The following block contains the hook’s stderr output.

每个 session 首次非静默 hook 失败时,还会附带调试 skill 的绝对路径与描述:stderr 已给出明确修复方式时直接处理,修复无效或原因不明时再读取 skill。skill 位于包内 `resources/bash-jobs-debug/SKILL.md`,随包发布但不注册到日常技能列表;成功、warning 和静默失败均不提供该入口。配置错误不会消耗首次 hook 失败的说明或 skill 入口机会。

每个 session 的首次 warning 和首次 failure 分别附带说明;后续同类诊断保留 envelope 和具体内容,省略重复解释。warning 不会消耗首次错误说明机会。静默错误不会消耗首次说明机会。配置错误使用 `action="config"` 的 envelope,在下一次 bash 调用时报告一次并使用对应的配置错误说明。无效配置条目会给出文件和条目位置并跳过,其他有效条目继续使用;整个 TOML 无法解析或版本不支持时不加载其中的 hook。

取消调用会终止当前命令 hook 及其子进程,不再执行后续 hook 或实际 bash 命令。初始化代码在 `set -e` 下运行;代码语法错误或返回失败时,实际命令不会执行,错误会作为 bash 工具结果返回。source hook 的生成失败和生成代码的执行失败是两个不同阶段。

通过 TypeScript 加载扩展时,仍可用 `createBashJobsExtension({ sourceHooks: [...] })` 追加编程 hook,它们在配置中的 hook 之后执行。`sourceCode({ cwd, env, signal, notify, report })` 返回 bash 代码或 `undefined`,异步操作应响应 `signal`,可通过 `report` 投递结构化错误诊断。配置命令的超时和输出限制由扩展负责,编程 hook 则负责自己的资源管理。

### TUI 中的后台 job 面板

- 有 job 在后台运行时,编辑器上方出现一个面板,折叠态只列出 running job 的编号。
- `alt+w` 展开/折叠当前 job 的命令、最近输出和更新时间;`alt+q` / `alt+e` 切换选中的 job;`alt+r` 终止选中的 job。
- 面板里的终止只负责杀进程,终态结果仍要靠 `bash_wait` / `bash_kill` 取回。仅在 TUI 模式下显示。

## 运行数据记录

每个 bash 调用、job 结束、bash_wait 和 bash_kill 都会记一条 JSON 行到:

```
$XDG_STATE_HOME/pi-bash-jobs/events.jsonl
```

(`XDG_STATE_HOME` 未设置时用 `~/.local/state`)

每条事件包含时间戳、session id、模型 id、命令的程序名(只取第一个词,跳过环境变量赋值)、耗时、最长无输出间隔、转入后台的原因、退出码、失败分类(`errorKind`:非零退出 / 中止 / 参数非法 / 执行失败)等。查询不存在的 job id 也会以 `state: "unknown"` 记录。**命令的参数不会记录**,避免 token 这类敏感信息落盘。

文件不做轮转,靠手工或外部脚本清理。这些数据用于分析模型使用习惯和调整默认等待时间,原型阶段保持默认开启。

## 不做的事

- stdin / TTY 交互:交互式程序、REPL、需要按键的 CLI 更适合交给 tmux 或 zellij。
- 完成通知:job 在 agent 空闲时结束不会主动唤醒模型,需等到下一次 `bash_wait`。

## 待决策

- 配套的 zellij / tmux SKILL:真正需要交互或长期运行的任务(dev server、REPL、交互式 CLI)交给终端复用器。等 MVP 用顺手了再定。
- **timeout 可配置**:目前 timeout 到点转入后台而不是杀进程,这样做贴合模型的实际意图。MVP 之后可以考虑加一个配置项,让需要旧行为的场景恢复"到点就杀"。

## 开发

在 monorepo 根目录运行：

```bash
aube install
mise run check   # 所有包的类型检查 + lint + 格式检查
mise run test    # 所有包的单元测试 + 基于 faux provider 的真实 session 测试
mise run fmt     # 格式化
```

只运行本包测试：`node --test packages/bash-jobs/test/`。

时间参数可通过 `createBashJobsExtension(timing)` 覆盖,默认值见 `src/index.ts` 的 `DEFAULT_TIMING`。
