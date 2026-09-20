# Motuo 公网入口验收

核验时间：2026-09-20 10:54 CST。公网 HTTPS 尚未上线；NAS 可达与公网可用是两个验收项。

| 检查 | 本轮实测 |
| --- | --- |
| 上海解析 `motuo.yundongyl.cn` | 无记录（`Name or service not known`） |
| 已知腾讯云凭据查询该域名 | `OperationDenied.NoPermissionToOperateDomain` |
| 上海→NAS `http://100.74.46.95:3020/healthz` | HTTP 200，`motuo-api` / `0.1.0` |
| 上海→NAS `/v1/vehicles` 无鉴权 | HTTP 401，`unauthorized` |
| 上海本机 HTTP + Motuo Host | HTTP 503，`https_pending`，ACME 路径预留 |
| 共享 Nginx | `nginx -t` 通过；已有 MIME/http2 警告保持原状 |
| 原 MedAgent `/api/health` 基线 | HTTP 503 / `degraded` / Mongo 不健康；本轮未改此服务 |

现有上海入口：`ubuntu@101.43.123.29`，`medagent-nginx` 容器；共享配置 `/opt/MedAgent_OS/nginx.conf` 是文件 bind mount。2026-09-14 的 HTTP 占位块已安装，备份为 `/opt/MedAgent_OS/.motuo-backups/nginx.20260914T091409.52de11324c25.conf`。本轮没有远端配置写入、证书申请或重载。

## 恢复公网发布

DNS 所有者需添加 **A / 主机 `motuo` / 值 `101.43.123.29` / 默认线路**，或提供有权操作 `yundongyl.cn` 的凭据。不要改主域、其他子域或使用本机 hosts 假装 DNS 生效。已知凭据位置为 `~/.tccli/default.credential`；只记录位置，不复制凭据。

在项目根执行：

```sh
python3 scripts/provision-edge-tls.py
python3 scripts/provision-edge-tls.py --apply
```

第一条只核验上海解析；只有解析地址集合准确等于 `101.43.123.29` 才允许第二条继续。第二条复用 `medagent-certbot` 的现有生产 ACME 账户及 webroot，只申请 `motuo.yundongyl.cn` 独立证书，不扩展其他证书，不接受新协议。随后 `deploy-edge.py` 只替换 Motuo 标记块，读取后 CAS 比对、原位写文件、保留备份、`nginx -t`、reload；任一步失败恢复原内容。共享文件有并发改动时会拒绝。

HTTPS 模板为 `deploy/nginx-https.conf`：API 反代 NAS 3020，上传上限 4 MiB，Motuo 独立限流区，TLS 1.2/1.3，HTTP 跳 HTTPS。证书目录 `/opt/MedAgent_OS/certbot/conf/live/motuo.yundongyl.cn/`。禁止 `curl -k` 或 App ATS 例外绕过证书。

启用后逐项记录：公网 `/healthz` 200；无鉴权 `/v1/vehicles` 401；真实配对和带鉴权请求；HTTP 301；证书主机名及有效期；原服务基线无回归。现有 MedAgent 健康不合格需由该项目独立处理，不能写成 Motuo 发布造成或已经修复。

现有 certbot 容器的续签运行方式应在证书创建后核对，并确认成功续签会触发 Nginx reload。不要为了完成本项目直接改变其他证书的续签调度。
