# Ownward 远程访问

Ownward 默认只监听 `127.0.0.1:4517`。想让 Android / iPhone 从外网访问，需要同时满足：

1. Ownward 显式开启 `dashboard.listen=all`（绑定 `0.0.0.0`）；
2. 外层使用可信的加密入口（Tailscale Serve/Funnel、Nginx 或 Cloudflare Tunnel）；
3. 保留 Ownward 自己的 token 鉴权，不把 4517 直接暴露到公网。

## 开启远程监听

推荐从工作台「设置 → 高级 → Dashboard」修改，审阅 diff 后应用。终端方式：

```json
{
  "dashboard": { "listen": "all" }
}
```

然后运行：

```bash
bash install.sh
```

首次从手机访问时，页面会要求输入 `data/secrets/api-token.txt` 中的 token；成功后换成 HttpOnly cookie。不要把带 token 的查询地址写入日志、截图或分享给别人。怀疑泄漏时，删除该文件并重新运行 `bash install.sh`，让所有客户端重新登录。

## Nginx 反向代理

先为域名配置有效 TLS 证书，再把请求代理到本机 daemon：

```nginx
server {
    listen 443 ssl;
    server_name ownward.example.com;

    # 避免把带 token 的首次登录地址写入日志
    access_log off;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4517;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

`X-Forwarded-Proto: https` 会让登录 cookie 带上 `Secure`；`X-Forwarded-For` 让 Ownward 能对真实客户端 IP 做失败限速。请同时在防火墙中阻断公网直连 4517。

## Cloudflare Tunnel

Tunnel 不需要在路由器开放入站端口：

```bash
cloudflared tunnel login
cloudflared tunnel create ownward
cloudflared tunnel route dns ownward ownward.example.com
```

在 `~/.cloudflared/config.yml` 写入 Tunnel UUID 和凭据路径：

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /Users/you/.cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: ownward.example.com
    service: http://127.0.0.1:4517
  - service: http_status:404
```

启动并验证：

```bash
cloudflared tunnel run ownward
```

确认手机可以访问后，再按 [Cloudflare 官方说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/) 注册为 macOS 常驻服务。主要通过浏览器使用时，可以再叠加 Cloudflare Access；原生 Android / iOS 客户端接入前，请先确认 Access 策略与其鉴权方式兼容。

## 检查清单

- [ ] 入口是 HTTPS（或处在可信的加密 tailnet 内），而不是裸露的 HTTP
- [ ] 4517 没有对公网开放
- [ ] Ownward token 仍然启用
- [ ] 反代透传 `Host`、`X-Forwarded-For`、`X-Forwarded-Proto`
- [ ] 日志、监控和分析工具排除了带 token 的查询参数
- [ ] Agent 的文件权限和 Provider 外发范围已按当前用户的风险接受程度审阅
