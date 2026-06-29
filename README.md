# Poker Scorer

部署在 Cloudflare Workers Free Tier 的实时德州扑克计分器（不发牌、不洗牌，只记筹码 / 盲注 / 行动轮转）。物理牌桌上的人打牌，本应用负责记录每手牌的筹码流动、盲注轮转和行动顺序。

## 文档

| 文档 | 内容 |
|------|------|
| [README.md](./README.md) | 本文件：项目概览与快速上手 |
| [docs/TECHNICAL.md](./docs/TECHNICAL.md) | 完整技术文档：架构、协议、关键逻辑、不变量、已知问题 |

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

## 项目结构

```
poker-scorer/
├── src/                # 后端 TypeScript（Cloudflare Worker + Durable Objects）
│   ├── index.ts        # HTTP 路由
│   ├── game-room.ts    # GameRoom DO（核心游戏逻辑）
│   ├── room-registry.ts# 房号注册 DO
│   ├── types.ts        # 类型、常量、工具函数
│   └── env.ts          # 环境绑定类型
├── public/             # 前端静态资源（零构建 ES Module + 原生 CSS，PWA）
├── test/               # Vitest 测试
├── docs/TECHNICAL.md   # 完整技术文档
└── README.md
```
