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
