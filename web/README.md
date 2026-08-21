# web/ — 前端静态资源（外部托管副本）

> ⚠️ **本目录是镜像副本，请勿直接编辑。**

前端源码（唯一权威来源）位于 `internal/webui/dist/`，通过 `go:embed` 内嵌进二进制。
本目录用于外部独立托管/分发场景。

**同步方式：**

```powershell
powershell -ExecutionPolicy Bypass -File scripts/sync-web.ps1
```

| 文件 | 说明 |
|------|------|
| `index.html` | 主界面（模型选择/参数表单/监控/日志） |
| `css/style.css` | 深色主题样式 |
| `js/app.js` | 主逻辑（API 调用、参数联动、预设、启动/停止） |
| `js/ws.js` | WebSocket 日志流客户端 |
| `js/charts.js` | ECharts 性能图表 |
