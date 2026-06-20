# Poker Scorer

部署在 Cloudflare Workers Free Tier 的实时德州扑克计分器。

## 架构

- 静态页面由 Workers Static Assets 提供。
- API 和 WebSocket 由 Worker 路由。
- 每个房间映射到一个独立的 SQLite-backed Durable Object。
- 同一房间内的操作由 Durable Object 串行处理，不同房间可以横向扩展。
- WebSocket 使用 Hibernation API，并把玩家身份保存在 socket attachment 中；房间空闲时可以休眠，不会因长连接持续消耗运行时长。

## 本地运行

```bash
npm install
npm run dev
```

## 验证与部署

```bash
npm run check
npm run deploy
```

`wrangler.toml` 中必须使用：

```toml
new_sqlite_classes = ["GameRoom"]
```

不要改回 `new_classes`，后者会创建旧式 KV-backed Durable Object，Workers Free Tier 不支持。

如果这个 Worker 的 `v1` 迁移以前已经成功创建过 KV-backed `GameRoom`，Cloudflare 不会把已存在的 namespace 原地转换为 SQLite。请先在 Cloudflare Dashboard 删除旧的 KV-backed Durable Object namespace（旧房间数据会被删除），然后再部署当前版本。若旧数据必须保留，应先在 Paid Plan 中导出并迁移数据。

## Free Tier 容量边界

Cloudflare 的免费额度会变化，部署前应以官方文档为准。当前架构不会绕过平台每日总额度；它解决的是后端类型兼容、房间内一致性和房间间横向扩展。静态资源不进入 Worker 时不消耗 Worker 请求额度。
