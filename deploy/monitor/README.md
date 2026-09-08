# API 健康监控工具

这个工具使用 Node.js 原生 `fetch`，不需要安装新依赖。它会并行检查 `endpoints.json` 中的接口，输出状态码和耗时；任一接口失败时进程以退出码 `1` 结束，适合接入 cron、systemd 或 Jenkins。

## 本地运行

```bash
node deploy/monitor/api-health-check.mjs
```

也可以指定其他配置文件：

```bash
node deploy/monitor/api-health-check.mjs /opt/pindou/monitor/endpoints.json
```

临时检查其他地址：

```bash
API_HEALTH_BASE_URL=https://api.pindou.wiac.xyz \
  node deploy/monitor/api-health-check.mjs
```

## 输出示例

```text
PASS API health and database | HTTP 200 | 82ms
PASS Public packages API | HTTP 200 | 91ms
PASS Privacy policy API | HTTP 200 | 76ms
Summary: 3 passed, 0 failed
```

## 服务器定时执行

将 `deploy/monitor` 复制到服务器后，可以使用 cron 每分钟检查一次：

```cron
* * * * * /usr/bin/node /opt/pindou/monitor/api-health-check.mjs >> /var/log/pindou-api-health.log 2>&1
```

同一台服务器上的定时检查只能发现 API 或数据库异常，无法发现服务器整体宕机。正式监控建议再使用另一台机器或公网监控服务访问：

```text
https://api.pindou.wiac.xyz/health
```

期望状态码为 `200`，响应 JSON 中 `status` 应为 `ok`。

## 添加接口

在 `endpoints.json` 的 `endpoints` 数组中增加配置即可。只建议加入无需用户登录、不会产生写入或扣费的 GET 接口。需要微信登录、上传文件、创建订单或修改数据的接口不适合直接作为定时健康检查。
