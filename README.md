# 德扑积分器（poker-scorer）

线下德州扑克**计分器**：不发牌、不洗牌、不判定牌力。物理牌桌上的人打牌，这个网站只负责记筹码、盲注、行动顺序、底池与主池/边池结算。

适合朋友聚会：手机打开即用，PWA 可装到主屏，断线自动挂机不误 fold。

线上地址：https://poker-scorer.1956133426lpy.workers.dev/

更完整的架构、协议、规则不变量与实现细节见 **[docs/TECHNICAL.md](./docs/TECHNICAL.md)**。读完本 README + 技术文档，应能独立理解、修改与部署整个项目。

---

## 它做什么 / 不做什么

| 做 | 不做 |
|----|------|
| 创建/加入房间，最多 12 人 | 发牌、洗牌、算牌力 |
| 记盲注、下注、跟注、加注、全押、弃牌 | 自动判定谁赢（由人在摊牌时选名次） |
| 轮转行动权，推进翻牌前→翻牌→转牌→河牌→摊牌 | 账号密码、房主权限、匹配大厅 |
| 主池/边池按排名分档结算 | 自动 straddle（最小加注已按上次有效加注额） |
| 断线坐出、补码、移除离线占座 | 中途销毁进行中的手牌 |

---

## 怎么用（线下场景）

1. 一人点 **创建新牌局**，输入昵称 → 得到 6 位房间码，分享给朋友。
2. 其他人输入房间码加入（或打开 `/?room=XXXXXX` 深链）。
3. 大厅可改盲注、给任何人 **+码**（默认 +1000）、**移除**离线占座者。
4. 至少 2 人在线且有筹码 → **开始游戏**。
5. 轮到你时底部出现操作栏：弃牌 / 过牌或跟注 / 加注 / 全押。
6. 本轮下注结束后点 **下一轮**（全员 all-in 等无法再对峙时会自动进摊牌）。
7. 摊牌：按牌力从强到弱选名次档位（可并列；有边池时用「下一档」排完）→ 查看服务端给出的「谁赢多少」预览 → **确认结算**。
8. 回到大厅，可继续下一手或补码。

**断线行为（刻意设计）**：手牌中断线的人**不会被弃牌**，只坐出挂机（占座、保底池权益、跳过行动）。本手内重连仍挂机，**下一手发牌**才复活。大厅里会显示「已离线 N 分钟」，方便桌上的人决定是否移除。

**信任模型**：首个成功入桌且带设备 ID 的玩家为**房主**。仅房主可改盲注、最终结算、给他人补码、移除离线；行动 / 开下一手 / 结算预览仍全员可操作。建房时可设可选入桌口令。

---

## 技术栈一览

| 层 | 选型 |
|----|------|
| 运行时 | Cloudflare Workers Free Tier |
| 房间状态 | SQLite-backed Durable Object（每房一个 `GameRoom`） |
| 房号目录 | Durable Object `RoomRegistry` |
| 实时通信 | WebSocket + Hibernation API |
| 前端 | 零构建 ES Module + 原生 CSS，PWA |
| 后端语言 | TypeScript |
| 测试 | Vitest + `@cloudflare/vitest-pool-workers` |
| 验证 / 部署 | GitHub Actions（typecheck + test）/ `wrangler deploy` 手动生产部署 |

核心设计：**瘦客户端**——前端只渲染后端下发的 `PublicGameState` / `currentPlayerIndex`，游戏判决全在 `GameRoom` 内串行执行。

---

## 项目结构

```
poker-scorer/
├── src/
│   ├── index.ts          # Worker 入口：HTTP 路由、建房、转发到 DO
│   ├── game-room.ts      # GameRoom DO：全部游戏逻辑 + WebSocket（核心）
│   ├── pot-settlement.ts # 主池/边池只读规划与精确预览
│   ├── player-rules.ts   # 可行动/争夺底池等纯谓词
│   ├── room-registry.ts  # RoomRegistry DO：房号唯一性
│   ├── types.ts          # 类型、常量、房号生成
│   └── env.ts            # Env 类型（继承 Cloudflare 生成绑定）
├── public/
│   ├── index.html        # 单页：首页 / 大厅 / 牌局 + 模态框
│   ├── styles.css        # 深色主题 + 移动端适配
│   ├── sw.js             # Service Worker（壳缓存）
│   ├── manifest.webmanifest
│   └── scripts/          # 前端模块（见技术文档）
├── test/
│   ├── game-room.test.ts # 端到端风格 DO 测试
│   └── pot-settlement.test.ts # 纯结算规划测试
├── .github/workflows/ci.yml # push/PR 自动验证
├── docs/
│   └── TECHNICAL.md      # 完整技术文档
├── wrangler.toml
├── package.json
└── README.md             # 本文件
```

---

## 本地开发

```bash
npm install
npm run dev          # wrangler dev，本地模拟 Worker + DO + 静态资源
```

浏览器打开终端提示的本地地址即可。

### 常用命令

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest（Cloudflare workers pool，沙箱里可能较慢）
npm run check        # typecheck + test + wrangler dry-run
npm run deploy       # 打印发布检查清单后部署到 Cloudflare Workers
npm run tail         # 线上实时日志
```

### 部署注意

- 后端改动**没有热更新**，必须 `npm run deploy` 后才对线上生效。
- 发布前同步更新 `SERVER_VERSION`、静态资源 `?v=` 与 Service Worker `CACHE`；`predeploy` 会打印检查清单。
- DO 房间状态跨部署保留；进行中的一手牌不会自动重写，**下一手/下一轮**才走新代码。
- `wrangler.toml` 必须保持 `new_sqlite_classes`（Free Tier 只支持 SQLite-backed DO）。**不要**改回 `new_classes`。
- 房号字符集为 `A-Z2-9` 且排除 `0/1`（防与 O/I 混淆）。自造含 0/1 的路径会落到静态资源而报错，属正常。

---

## 扑克规则速记（改代码前必读）

完整说明与实现位置见技术文档「扑克规则不变量」一节。

**行动顺序**

- 座位：`position` 0=庄家 D / 1=小盲 SB / 2=大盲 BB / 3=UTG…
- 多人：翻牌前 UTG 先动；翻牌后 SB 先动。
- **单挑**：庄家即 SB；翻牌前 SB 先动；**翻牌后 BB 先动**（标准规则，不是 bug）。

**断线坐出**

- 可行动：`!isFolded && isActive && !isAllIn && !isSittingOut`
- 争夺底池：`!isFolded`（含挂机，防止一人断线另一人独赢）
- 绝不要改回「断线=弃牌」。

---

## 已知局限（可接受简化）

这些在线下熟人局通常够用；改之前先读技术文档对应章节。

- **无 straddle**。
- **无完整账号体系**：房主绑定 `deviceId`（首个入桌设备），不支持转让 UI / OAuth。
- **每日北京时间 04:00**：waiting 时 **soft reset**（保留座位与筹码，清牌局进度）；手牌进行中推迟 15 分钟。**7 天 TTL** 仍硬销毁房间。
- 摊牌胜者由人手选；边池要求按牌力**排完名次档位**，否则服务端拒绝结算并提示。

---

## 文档

| 文档 | 用途 |
|------|------|
| [README.md](./README.md) | 产品说明、上手、结构、部署入口 |
| [docs/TECHNICAL.md](./docs/TECHNICAL.md) | 架构、协议、关键逻辑、不变量、前后端同源清单、运维 |
| [docs/ARCHITECTURE_PATTERNS.md](./docs/ARCHITECTURE_PATTERNS.md) | 设计模式映射、分层依赖、演进清单（接替已完成的 issue 任务卡） |

历史 WORKLOG / 审计 / 任务卡结论已并入技术文档与架构模式文档。
