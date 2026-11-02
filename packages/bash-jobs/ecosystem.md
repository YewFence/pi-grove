# 社区生态调查:后台化 bash 插件

> 调查时间:2026-09-28。来源:`gh search repos`、[awesome-pi](https://github.com/bubbleptr/awesome-pi) 的 Background Tasks 分区、各仓库当时的 README。细节随版本变化很快,引用前请核对上游现状。

## 结论

「正式 background-bash」路线在社区已有成熟插件,但没有人做 pi-bash-jobs 这个轻量兜底位:不改模型习惯、不换执行层,只把内置 bash 的「超时杀掉」变成「超时让出」。目前没有重新造轮子。

## pi-bash-jobs 的差异点

- 不改变模型习惯:参数只有原本的 `command` 和 `timeout`,没有 `background: true` 之类的新概念;`timeout` 从「到点杀」变成「到点让出」,模型不会再陷入「超时写短了 → 被杀 → 重试又写短」的循环。
- 够轻:快路径与内置 `bash` 完全一致——执行、截断、临时文件、渲染全部复用,其他扩展挂在 `bash` 上的 `tool_call` / `tool_result` 钩子照常生效。
- 结果交付是 pull 模型:`bash_wait` 拉取 + 指数退避,不往会话注入消息、不唤醒 agent。
- 代价:与其他替换 `bash` 的扩展互斥。

## 已有插件

### [sshkeda/pi-background-bash](https://github.com/sshkeda/pi-background-bash) — 最接近的同类

- 安装:`pi install git:github.com/sshkeda/pi-background-bash`
- 路线:正式 background-bash。`background: true` 主动放后台;前台命令固定 30 秒后自动转后台;`timeout` 到点杀进程。
- 结果交付:push 模型。命令完成时注入 `<pi_context source="pi-background-bash" kind="background_bash_result">` 并唤醒 agent,模型无需轮询。
- 执行层:v1 起用自有 PBB runner(`bash -lc`)接管执行,记录 `pid`/`pgid`,按进程组杀;附 `pbb tail <job> --full` CLI 查看完整输出,完整输出存 PBB 日志。

|            | pi-bash-jobs                                          | pi-background-bash       |
| ---------- | ----------------------------------------------------- | ------------------------ |
| 定位       | 兜底,不改模型习惯                                     | 正式后台方案             |
| 转后台时机 | timeout 到点足额等 / 未设 timeout 时 15s 静默 / 30min | 固定 30s                 |
| 主动后台   | 不做(要就 `nohup`)                                    | `background: true` 参数  |
| 结果交付   | pull:`bash_wait` + 指数退避                           | push:context 注入 + 唤醒 |
| 执行层     | 复用 pi 内置                                          | 自有 PBB runner 接管     |

GitHub 上另有 `Insanitier/pi-background-bash` 和 `mowenroot/pi-background-bash` 两个同名空描述仓库,疑似复刻,未细查。

### [@aliou/pi-processes](https://github.com/aliou/pi-processes) — 独立后台进程管理

- 安装:`pi install npm:@aliou/pi-processes`
- 面向 dev server、test watcher、日志 tail 这类刻意放后台的进程;从 README 看提供独立的进程管理工具和 `/ps` 面板,不替换 `bash`(未读源码验证)。
- 事件驱动唤醒:日志出现 readiness marker(如 server 打印 "ready")、出现错误、进程退出时自动把 Pi 拉回来;watch 触发太频繁可以静音而不重启进程。
- awesome-pi 的 Background Tasks 分区唯一条目。

### [pi-interactive-shell](https://github.com/nicobailon/pi-interactive-shell) — 交互 CLI(互补方向)

- 安装:`pi install npm:pi-interactive-shell`
- PTY 全仿真,模型自主操控 vim / psql / ssh / rebase 等交互式 CLI,不依赖 tmux;用户可随时接管。
- 对应本仓库 README「不做的事」里 stdin / TTY 交互那条的另一种解法,即「待决策」里 zellij/tmux SKILL 想覆盖的场景。

### pi-codex-conversion(Structured 模式)— 语义上的上游

- Codex unified exec 语义:`exec_command` + `write_stdin`,session 化,无限次增量取回;进程退出且输出读干后才移除 session。
- 有最近 32 个已完成 session 的 LRU 重放(各存 64KB 尾巴):取回终态后的迟到空轮询能拿到重放结果,而不是报错。
- 空轮询退避每次 ×2,上限 30 分钟;默认 10 秒让出。与本仓库互斥(两套 shell 工具)。

## 互斥与共存

| 插件                                | 关系                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| pi-background-bash                  | 互斥:同样整体替换 `bash` 工具                                                            |
| pi-codex-conversion Structured 模式 | 互斥:`exec_command` + `bash` 两套 shell 工具                                             |
| @aliou/pi-processes                 | 未发现替换 `bash` 的迹象,技术上应可共存;用途重叠,同时装会让模型面对两套等价机制,自行权衡 |
| pi-interactive-shell                | 互补,覆盖交互场景                                                                        |

## 之后可能想偷的特性

- 完成时注入 `pi_context` 并唤醒 agent(pi-background-bash):解决「agent 空闲时 job 结束不会主动唤醒」。等 `events.jsonl` 数据证明模型经常空轮询再考虑。
- readiness marker 唤醒(pi-processes):dev server 场景比固定退避更聪明。
- 已完成结果的 LRU 重放(pi-codex-conversion):取回终态后的迟到查询不报 `Unknown job`。
