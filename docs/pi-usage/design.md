# Pi Usage 扩展设计（coding 可观测性）

状态：已实现 v1，统计口径与归属语义仍与实现保持同步。

目标场景是 GitHub profile README 的 Coding Insights 区块（原由 waka-readme 从 WakaTime API 渲染），用自有可观测性栈替换数据来源，保留渲染效果。

本文与历史 wakatime 调研的关系：统计口径、归属规则与文件变化识别沿用 pi-usage 的前身 pi-wakatime 的调研成果，那是本地归属账本的设计，与上报目标无关。WakaTime 特有的内容（心跳语义、服务端超时拼接、`--time` 技巧、`Other` 口径、迟到心跳验证）全部废弃——OTel span 自带显式 start/end/duration，不再需要靠"下一条心跳承接间隔"来暗示时长。

## 目标与边界

在自有可观测性栈中记录使用 Pi 工作的时间：项目、语言、有效工作时长、文件明细。输出物有两个：Grafana dashboard（含 wakatime 风格的语言饼图、项目时间线）和 README Coding Insights 渲染。

与 LLM 可观测性的分工：pi-usage 只负责 coding 活动的统计（时间、语言、项目归属），不涉及模型、token、prompt 成本等统计信息。AI 可观测性已有成熟方案（Langfuse、Phoenix 等），pi-usage 专注于 coding activity 的统计。语义约定上不复用 `gen_ai.*` 属性族，自定义 `coding.*` 命名空间。这不是"少配几个字段"，而是数据源（本地归属账本）里本来就没有这些信息。

现有 pi-otel 类插件做的是 LLM span/token 可观测性，与本扩展互补不冲突，可共存。

## 数据模型

### Trace 结构

```
trace  = 一个 Pi 会话（trace_id 从会话 ID 确定性派生，使同会话 span 聚合）
└─ span: pi.request（每次用户请求一个 root span）
    ├─ span: pi.segment（结算出的文件归属段落）
    ├─ （等待用户在瀑布图上表现为 span 之间的空隙）
    └─ span: pi.segment（应用活动段落）
```

request span 覆盖请求从处理开始到最终结束的墙钟时间（含等待间隙），segment span 是账本结算出的互不重叠的有效工作段落。等待时间在瀑布图上自然呈现为空隙——**瀑布图就是归属启发式的可视化验证器**，旧设计文档示例表格中的场景（90 秒 Python、40 秒双 TypeScript 均分、15 秒应用、120 秒等待）可以在 trace 视图中直接目视核对。

### Segment span 属性

| 属性                  | 说明                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `coding.segment.kind` | `file` 或 `app`（应用活动，对应 wakatime 语义的 Other）             |
| `coding.project`      | 项目名：git root 目录名优先，退化到 cwd basename                    |
| `coding.language`     | 由文件扩展名映射；app 段落和无语言证据的段落不携带                  |
| `coding.entity`       | 相对项目的文件路径。可配置为完整 / 关闭；不进任何 metrics dimension |
| `coding.request.id`   | 归属请求标识，供 TraceQL 钻取                                       |

span name 固定为 `pi.request` / `pi.segment`，不嵌入文件名或项目名（spanmetrics 会把 span name 变成 label，必须保持稳定低基数）。span kind 用 `INTERNAL`。

### Resource 属性

`service.name=pi-usage`、`service.version`、`host.name`、`os.type`、Pi 版本。README 的 "Editors & Agents" 维度对应 `service.name`（未来其他 agent/编辑器接入同一栈时可扩展），OS 维度对应 `os.type`。

### 指标双计数问题

spanmetrics 对所有 span 生成延迟直方图，request span 与 segment span 叠加会双计时间。约定：只有 segment span 携带 `coding.*` 属性，所有聚合查询以 `coding_segment_kind=~".+"` 过滤，request span 仅提供 trace 结构，不参与时长聚合。

## 统计口径与归属

沿用 pi-wakatime 调研已确定的口径，要点摘录（细节以历史调研稿为准，如有冲突以本文为准）：

- **有效工作时间**：从实际开始处理请求到该轮工作完全结束，含模型思考、读文件、工具执行与网络等待；等待用户输入/批准/对话框期间暂停，等待时间不计入。
- **文件与语言投入时间**：为产生一次可识别文件修改而尚未分配的有效工作时间，按 turn 批次的修改文件均分；整轮无修改或最后修改后的收尾归应用活动。
- **不变量**：每段有效时间最多分配一次；文件归属加应用归属等于有效工作时间；多文件均分总量守恒；新请求不继承上一请求未分配时间。
- **修改确认**：以前后内容哈希/字节比较为准，工具报告成功不算数；识别失败的修改不产生归属。比较只在本地进行，内容不出本地。
- **第一版范围**：只识别 `edit`、`write` 等有明确目标路径的工具；不解析 Shell 命令写文件；改动行数指标后续版本再议。
- 与旧文唯一的语义差异：旧文把应用活动映射为 wakatime 的 `app` 实体/`Other` 类；本文把应用活动作为 `coding.segment.kind=app` 的正式段落类型，与其他段落同级存储，不再有"Other 被排行榜扣除"的口径分裂。

## OTLP 导出

### 标准遵循与后端无关性

扩展只依赖 OTel 稳定面：OTLP/HTTP 协议、trace/span 数据模型、W3C trace context、标准 resource 属性。配置走标准环境变量（`OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_EXPORTER_OTLP_HEADERS`、`OTEL_RESOURCE_ATTRIBUTES`），行为与任何 OTel 插桩应用一致。

后端无关是验收标准：把 endpoint 指向任意 OTLP receiver（Tempo、Jaeger、OTel Collector、Grafana Cloud、调试用本地 collector）都必须能工作。扩展代码不调用任何 Tempo 专有 API（TraceQL、metrics-generator 配置、专有 header），不使用 `traces_spanmetrics_*` 这类后端产物名。

Tempo 特有的部分全部隔离在服务端：metrics-generator 配置是部署侧的 Tempo 配置文件，spanmetrics 指标名只出现在 dashboard 与 README renderer 的查询里。renderer 的 PromQL 做成可配置模板，同时给出 Tempo spanmetrics（`traces_spanmetrics_latency_sum`）与 OTel Collector spanmetrics connector（`duration_sum`/`calls_total`）两套命名。

`coding.*` 是唯一的自定义面，符合 OTel 对领域属性的惯例：semconv 没有 coding activity 约定，自定义属性使用自己的命名空间。未来若上游出现相关约定再评估迁移。

### 发送时机与回溯时间戳

segment span 在结算时（turn 批次完成、请求结束、会话关闭）立即发送，`startTime`/`endTime` 用账本中的真实活动时间，不用发送时刻的墙钟。这是相对 wakatime 心跳模型的核心优势：时长是显式字段，不存在服务端拼接。

注意后端的 metrics-generator ingestion slack（Grafana Cloud 默认 30 秒，自托管可配）：结算距段落结束超过 slack 的 span 会进入 traces 但不进 spanmetrics。正常结算延迟是秒级，无影响；崩溃恢复重放的旧段落会超出 slack，保守处理为"只进 traces，接受指标缺失"，不为旧数据伪造新鲜时间戳。

### 实现选型

手写 OTLP/HTTP JSON 导出，不依赖 `@opentelemetry/*` SDK。理由：我们需要显式回溯时间戳、自带磁盘持久化的有界发送队列和单发送者语义，SDK 的 BatchSpanProcessor 与持久化需求重叠而又不满足；span 的 OTLP JSON 映射面很小且稳定，手写约百行换来零运行时依赖。协议面仍是标准 OTLP，后端无关性不受影响。本地归属账本仍是事实来源；导出器的 JSON 状态文件只承载已结算未送达的 span。

### 可靠性

沿用旧文"发送与生命周期可靠性"一节，把"CLI 子进程"替换为"HTTP 请求"：事件处理不等待网络；有界发送队列；请求超时与失败退避，不随工具事件高频重试；退出时有期限收尾，超期保留本地待发送记录；崩溃恢复后不推断 Pi 仍在工作；日志不输出密钥、prompt、文件内容、命令文本。

## 后端与指标生成

```
pi 扩展 --(OTLP/HTTP spans)--> Tempo
  ├─ metrics-generator (spanmetrics, dimensions: coding_language / coding_project / coding_segment_kind)
  │     --(remote-write)--> Prometheus   ← dashboard 与 README renderer 查询处
  └─ TraceQL（Grafana ad-hoc 钻取：单会话瀑布图）
```

自托管 Tempo 的 metrics-generator 参考配置（指标名与 label 以实际部署版本输出为准）：

```yaml
metrics_generator:
  processors: [span-metrics]
  processor:
    span_metrics:
      dimensions: [coding.language, coding.project, coding.segment.kind]
      # 回溯时间戳场景下调大 ingestion slack，避免结算稍晚的 span 被丢弃
  registry:
    external_labels:
      source: pi-usage
storage:
  trace:
    wal: ...
    local: ...
```

生成指标形如 `traces_spanmetrics_latency_sum` / `traces_spanmetrics_calls_total`，label 含 `service_name`、`span_name`、`span_kind`、`status_code` 及上述 dimensions（点号清洗为下划线）。`latency_sum` 即段落时长之和，正是语言/项目饼图所需。

### 指标生成的中性替代

若想让指标生成也 vendor-neutral，可在管道中插入自有的 OTel Collector，用 spanmetrics connector 生成 `duration_sum`/`calls_total` 并 remote-write 到 Prometheus，Tempo 退化为纯 trace 存储。代价是多维护一个 collector 进程。第一版默认走 Tempo metrics-generator（少一个组件），两条路都不影响扩展实现。

### Grafana Cloud 备选路径的已知限制

已核实（2026-02，Grafana Cloud 官方文档）：

- metrics-generator 默认关闭；App Observability 默认只覆盖 `SERVER`/`CONSUMER` span kind，`INTERNAL` 需联系 Support 开启。
- 自定义 dimensions、解除 Adaptive Metrics 的 label 聚合均需联系 Support。
- metrics-generator ingestion slack 默认 30 秒且只能由 Support 调整。
- TraceQL metrics 查询默认限制 24 小时窗口（可申请提高），不足以直接支撑 "Last 7 Days"。
- 免费档 metrics/logs/traces 保留期均为 14 天：README 的 7 天窗口可用，但无长期历史。

结论：Grafana Cloud 可行但需要多个 Support ticket 且受 14 天窗口约束；自托管 Tempo 无此摩擦，为第一选择。无论哪条路，README renderer 的 7 天聚合都走 Prometheus 上的 spanmetrics 输出，不直接扫 Tempo。

### 公网暴露

数据敏感度低（项目名、语言、时长、可选文件路径），公网可达加认证是可接受风险。GitHub Actions 只需要 Prometheus 的只读查询端点（自托管则在 traefik 后加认证，或经 Tailscale）；Tempo ingest 端点只需写凭证。仪表盘访问走 Grafana 自身认证。

## README 渲染

替换 waka-readme action：定时 GitHub Actions workflow 运行一个小 renderer，查询 Prometheus HTTP API，生成同样的 ASCII 条形图，提交到 profile README 的 markers 之间。

示例查询（Tempo spanmetrics 命名；renderer 以查询模板适配后端，label 名以实际部署为准）：

```promql
# 总时长（小时）
sum(increase(traces_spanmetrics_latency_sum{service_name="pi-usage", coding_segment_kind=~".+"}[7d])) / 3600

# 语言 Top 5
topk(5, sum by (coding_language) (increase(traces_spanmetrics_latency_sum{service_name="pi-usage", coding_segment_kind="file"}[7d])))

# Editors & Agents（Pi 部分）
sum by (service_name) (increase(traces_spanmetrics_latency_sum{coding_segment_kind=~".+"}[7d]))
```

数据源合并策略：Pi 时间来自 Prometheus；Neovim 等编辑器时间仍查 WakaTime API（其编辑器心跳插件无 AI 扫描行为，可保留），renderer 把两个来源合并渲染到同一区块。若未来彻底脱离 WakaTime，只需删掉该数据源分支。

## 状态与模块边界

三个职责与旧文一致，仅第三层替换：

1. Pi 事件适配：辨认请求、turn、等待、修改批次和生命周期事件，获取文件变化证据。
2. 本地归属账本：有效时间片、未分配段、结算；只处理时间与归属，不调用网络。
3. OTLP 导出：把已结算段落转换为 span，负责批量、顺序、失败退避与退出收尾。

包结构遵循 monorepo 约定：`packages/usage`，插件名 `pi-usage`，独立依赖、manifest、README、CHANGELOG。v1 已实现，覆盖账本的完整测试，当前处于等待真 Tempo 验证的在线验证阶段。

## 验证与验收

### 本地自动验证

沿用旧文的账本测试清单（时间守恒、暂停嵌套、批次均分与完成顺序无关、崩溃恢复、生命周期清理等），新增：

- span 的 start/end 使用账本真实时间而非发送时刻；同一 turn 的多文件段落时间线互不重叠。
- request/segment 层级正确；segment 属性的语言映射、项目探测、路径脱敏配置生效。
- 导出失败退避、有界队列、退出收尾与 JSONL 重放。
- 测试使用受控时钟与替代 OTLP endpoint，默认不外发。

### 线上小规模验证

用固定样例工作（Python 单文件、双 TypeScript 并行、纯调查、含暂停）后目视核对：

- trace 瀑布图与旧文示例表格一致：等待是空隙、均分是等长并列段、收尾是 app 段。
- Prometheus 上 `increase(latency_sum[...])` 与本地账本合计在合理误差内相等（注意 slack 丢弃与 ingest 延迟）。
- README renderer 以固定时间窗跑一次，人工核对数字与 dashboard 一致。

### 第一版完成标准

本地时间账本完整可复现；OTLP 导出与队列可靠性经过验证；Grafana dashboard 能按语言/项目聚合；README renderer 能合并 Prometheus 与 WakaTime 两源渲染出原有区块效果。已知的脚本漏记、并发归因、调查归配置文件、slack 丢弃等偏差明确保留并写入文档。

## 待决事项

- 后端落地：自托管 Tempo（首选）还是 Grafana Cloud（需 Support ticket 开 INTERNAL spanmetrics 与 dimensions）。
- 自托管栈暴露方式：traefik 认证路由还是 Tailscale Funnel，供 GitHub Actions 查询。
- 包名最终确认（`pi-usage` / `pi-worklog` 等）与 `packages/wakatime` 的去留。
- 仓库级 ADR：从 wakatime 心跳模型转向 OTel traces 的决策需要按 `docs/adrs/` 惯例记录。

## 参考资料

- [Tempo metrics-generator](https://grafana.com/docs/tempo/latest/metrics-from-traces/metrics-generator/)
- [Span metrics processor](https://grafana.com/docs/tempo/latest/metrics-from-traces/span-metrics/span-metrics-metrics-generator/)
- [Metrics-generator in Grafana Cloud Traces](https://grafana.com/docs/grafana-cloud/send-data/traces/configure/metrics-generator)
- [TraceQL metrics queries](https://grafana.com/docs/tempo/latest/metrics-from-traces/metrics-queries/)
- [Grafana Cloud 免费档](https://grafana.com/products/cloud/free-tier)
- [OTel Trace SDK（JS）](https://opentelemetry.io/docs/languages/js/)
- pi-wakatime 历史调研稿（统计口径与归属规则的全部细节与调研依据，原 pi-wakatime-design.md）
