# ADR 0002:从上游改写移植 TUI widget,进程清理守住进程组边界

- 状态:已接受
- 日期:2026-09-28(移植决策),2026-10-11(进程清理边界补全)

## 背景

ADR 0001 定下「兜底」定位后,悬垂进程的问题立刻浮现:`timeout` 从「到点杀」改成「到点让出」,一个卡住的 job 如果模型不再理会,会一直跑到 session 关闭。模型遗忘 job 的主要途径是上下文压缩,job id 可能随历史一起被压掉。

需要一个不占用提示词、不扩大模型工具表面积的兜底通道。候选是照搬上游 `pi-codex-conversion` 的 `background-bash-widget`:在 TUI 里列出运行中的 job,配快捷键让人手动 kill。移植方式和进程清理边界是这个 ADR 的两块。

## 决策

### 移植方式:按本仓库结构改写,不原样 cp + 适配层

- widget 和 `renderTerminalOutput` 改成直接读本插件的 job 表,文件头保留 MIT 声明和出处。
- 不模拟上游 `ExecSessionManager` 的接口再写一层适配。

### 面板范围:只显示 running job

- 已结束但结果未取回的 job 不显示。面板的用途是兜底悬垂进程,已结束的 job 不占资源,显示出来是噪音。

### 进程清理:守进程组 SIGKILL,不搬上游扫描进程表的彻底方案

- 沿用 pi 自带的 `killProcessTree`:`spawn` 时 `detached: true` 让 shell 自成进程组 leader,kill 时 `process.kill(-pid, "SIGKILL")` 端掉整个进程组。`bash_kill`、session shutdown、转后台前 Esc 都走这条。
- **不**搬上游那套扫描进程表、找出所有子孙进程、连另开进程组的也一并杀掉、杀不掉再补杀的逻辑。
- `setsid` 另开会话/进程组能脱离杀伤范围,列为已知限制,写进文档。

## 理由

**改写优于适配层。** 上游 widget 和它自己的 `ExecSessionManager`、`CodexConversionConfig` 耦合很深,适配层写出来不会比改写少,还得多维护一层假接口。改写约 150~200 行,是可接受的量。

**只显示 running job。** 面板杀掉 job 时不引入新规则:被杀的 job 留在表里,模型下次调 `bash_wait` 拿到 `killed` 结果后才移除,和正常生命周期一致。

**守进程组边界足够。** pi 自带的按进程组 `SIGKILL` 已经覆盖了绝大多数情况:普通 `&`、`nohup &` 都跑不掉(实测 `nohup` 只忽略 `SIGHUP`,对 `SIGKILL` 形同虚设)。上游那套扫描进程表的逻辑要解析 `/proc`、分平台、维护成本不低,MVP 先观察。真正能逃逸的只有 `setsid`,而模型主动 `setsid` 本身就是「我想让它留后台」的意图信号——README 也写明了刻意放后台直接 `nohup`/`setsid`,这不算漏洞,是边界。

**关键澄清:本插件的 timeout 不杀进程。** `createYieldingOperations` 把传给底层的 `timeout` 显式置为 `undefined`,底层那个会触发 `killProcessTree` 的定时器根本不挂。idle、用户 timeout、30 分钟封顶,到期都走 `yieldToBackground`——收编成 job、返回 `Job N still running`、进程继续跑。连坐杀子进程只发生在 `controller.abort()` 被触发的三条路径(`bash_kill`、shutdown、转后台前 Esc),不在 timeout 路径上。这是本插件相对内置 bash 最关键的行为改变。

## 被否掉的备选

- **原样 cp 上游文件 + 适配层**:耦合深,适配层不比改写少,见上。
- **面板显示已结束未取回的 job**:噪音,违背「兜底悬垂进程」的用途。
- **搬上游扫描进程表的彻底杀进程方案**:维护成本高,分平台,且 `setsid` 逃逸对兜底定位不算问题。
- **给模型加 job 的 R/U 工具**:`bash_kill`(D)已有,后来考虑过加 list(R)和 update(U)语义。否决——本插件常态下最多一两个 job 并发,CRUD 太重没必要;需要持续操控的 U 场景(dev server、交互式 CLI)走 tmux/zellij(README「待决策」里那条 SKILL,尚未落地)。悬垂进程的可见性交给下面的 TUI 面板,不交给模型。
- **状态栏只显示计数(如 `jobs: 2 running`)**:比 widget 更轻,但不能直接动手处理,只能再让模型 `bash_kill`。widget 加快捷键一步到位。

## 后果

- 正面:悬垂进程有人兜底,不占提示词;面板自动出现/消失(有 running job 才显示);沿用上游快捷键(`alt+w`/`q`/`e`/`r`),和 codex 养成的习惯一致。
- 负面/残留:`setsid` 逃逸、pi 自身被 `SIGKILL` 来不及清理这两种情况写进已知限制;转后台之后 Esc 不再连到 controller(`forwardAbort` 已移除),Esc 杀不动后台 job,只能靠面板或 `bash_kill`。
- 许可证:上游 MIT,版权人 Igor Warzocha,改写后的文件头保留声明,本包 `package.json` 补 `license` 字段。
