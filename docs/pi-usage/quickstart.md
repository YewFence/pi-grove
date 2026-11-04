# 快速启动 pi-usage 后端

这个 compose 文件是一个**最小可用**的本地 Tempo + Grafana 栈，用于验证 pi-usage 的数据流和 dashboard。数据存在 compose 卷里，重启后还在。

```bash
cd packages/usage/examples

# 拉起 tempo + grafana
docker compose up -d

# 在另一个终端跑 pi（先设置环境变量）
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
pi

# 打开 grafana（datasource 和 dashboard 都配好了）
open http://localhost:3000
```

访问方式：

| 服务 | 地址 | 默认账号 | 说明 |
| --- | --- | --- | --- |
| Tempo OTLP | `http://localhost:4318` | - | 接收 OTLP span |
| Grafana | `http://localhost:3000` | `admin` / `admin` | Tempo + Prometheus 数据源、Dashboard 都预配好 |

**不需要手动配数据源或导入 dashboard**：compose 已经把 Tempo 数据源和 `dashboard.json` 都挂载到 Grafana 的 provisioning 目录，启动后数据源自动可用，dashboard 在 `pi-usage` 文件夹下。打开 Grafana 就能看到数据（可能需要 30 秒左右 spanmetrics 生成指标）。

## 停止并清理

```bash
docker compose down           # 数据保留
docker compose down -v        # 数据清空
```

## 常用环境变量

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
# 如果 Tempo 在另一台机器，用这个:
# export OTEL_EXPORTER_OTLP_ENDPOINT=http://pi.local:4318
# 认证（如果 Tempo 挂了认证）:
# export OTEL_EXPORTER_OTLP_HEADERS="authorization=Basic base64编码"
# 不开箱即用文件路径，只发项目/语言/时间:
# export PI_USAGE_ENTITY=off
```

## 调试技巧

如果打开 Grafana 看不到数据，先检查：

```bash
# Tempo 是否收到了 span
curl -s "http://localhost:3200/api/search?q=pi-usage" | jq .
# 应该返回 trace 列表，里面有 pi.request 和 pi.segment

# Prometheus 是否收到了指标
curl -s "http://localhost:3200/api/metrics/labels" | jq .
# 应该能看到 coding_language, coding_project, coding_segment_kind
```

如果 Tempo 收到了 span 但 Prometheus 没指标，可能是 metrics-generator 还没生成（默认每 60 秒生成一次）。等 60 秒再查。

## 更多选项

这个栈足够本地验证，不适合生产。看看 [`tempo.yaml`](./tempo.yaml) 了解生产部署，或者用 OTel Collector 替代 metrics-generator 的路线（`duration_sum` 命名）。

这个栈足够本地验证，不适合生产。看看 [`tempo.yaml`](./tempo.yaml) 了解生产部署，或者用 OTel Collector 替代 metrics-generator 的路线（`duration_sum` 命名）。
