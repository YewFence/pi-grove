# ADR 0006:独立配置成功 hook 的 stderr 报告

- 状态:已接受,取代 ADR 0005 中成功时丢弃 stderr 的策略

## 背景

退出码 0 表示 hook 生成成功,stderr 仍可能包含影响环境诊断的提示。是否报告成功时的 stderr,与失败是否静默是两个独立选择。

## 决策

- 每条 hook 支持 `report_stderr_on_success`,默认 `true`,不受 `quiet` 影响。`quiet` 继续只控制失败诊断。
- 退出码 0 且 stderr 非空时,按该配置决定是否输出 `outcome="warning"` 的 envelope。stdout 初始化代码继续执行,不自动判断为部分降级。
- warning 沿用既有 stderr 捕获限制、信封预算、边界转义及后台投递路径。用户可通过包装脚本清洗输出。
- 每个 session 首次 warning 与首次 failure 分别解释来源。warning 只说明 hook 成功、初始化代码将继续执行、后续块是 stderr,不提前声称环境更新已经应用。

## 理由

单一静默开关无法表达“隐藏预期失败但保留成功警告”或“报告失败但过滤成功提示”。两个独立配置让用户明确选择报告行为,同时保持退出码与初始化代码的执行策略不变。
