# API 健康监控工具

工具使用 Node.js 原生 `fetch`，不需要安装新依赖。它会并行检查 `endpoints.json` 中的接口，输出状态码、响应耗时和失败原因；任一接口失败时进程以退出码 `1` 结束。

## 运行

```bash
node deploy/monitor/api-health-check.mjs
```

指定配置文件：

```bash
node deploy/monitor/api-health-check.mjs /opt/pindou/monitor/endpoints.json
```

临时覆盖监控地址：

```bash
API_HEALTH_BASE_URL=https://api.pindou.wiac.xyz \
  node deploy/monitor/api-health-check.mjs
```

## 当前检查接口

- `GET /health`：检查 API 和 PostgreSQL，要求返回 `200` 且 JSON `status` 为 `ok`。
- `GET /api/packages`：检查公开套餐接口。
- `GET /api/legal-documents/privacy-policy`：检查公开法律文档接口。

只建议加入无需登录、不会产生写入或扣费的 GET 接口。微信登录、上传、支付、修改和删除接口不适合作为定时健康检查。

## 服务器定时执行

将 `deploy/monitor` 复制到服务器后，可以使用 cron 每分钟检查：

```cron
* * * * * /usr/bin/node /opt/pindou/monitor/api-health-check.mjs >> /var/log/pindou-api-health.log 2>&1
```

工具返回退出码 `1` 时，可由 cron、systemd 或外部监控平台触发告警。建议同时使用另一台机器或公网监控服务访问 `https://api.pindou.wiac.xyz/health`，这样服务器整体宕机时仍能发现故障。

## 添加接口

在 `endpoints.json` 的 `endpoints` 数组中添加路径即可。可用 `expectedJson` 校验响应中的点号路径，例如：

```json
{
  "name": "example",
  "path": "/example",
  "expectedStatus": 200,
  "expectedJson": {
    "status": "ok"
  }
}
```
