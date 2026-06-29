# poker-scorer 技术文档

> 实时德州扑克计分器 — 完整架构与实现细节
>
> **目标读者**：AI Agent、代码工程师。本文档涵盖架构、协议、关键逻辑、不变量与已知问题。
>
> 最后更新：2026-06-29

---

## 目录

1. [概览](#1-概览)
2. [架构](#2-架构)
3. [目录结构](#3-目录结构)
4. [后端详解](#4-后端详解)
   - [4.1 入口路由 (index.ts)](#41-入口路由-indexts)
   - [4.2 类型与常量 (types.ts)](#42-类型与常量-typests)
   - [4.3 游戏房间 DO (game-room.ts)](#43-游戏房间-do-game-roomts)
   - [4.4 房间注册表 DO (room-registry.ts)](#44-房间注册表-do-room-registryts)
   - [4.5 环境绑定 (env.ts)](#45-环境绑定-envts)
5. [前端详解](#5-前端详解)
   - [5.1 HTML 结构](#51-html-结构)
   - [5.2 CSS 设计系统](#52-css-设计系统)
   - [5.3 JS 模块职责划分](#53-js-模块职责划分)
   - [5.4 WebSocket 协议](#54-websocket-协议)
   - [5.5 前后端同源逻辑](#55-前后端同源逻辑)
6. [扑克规则不变量](#6-扑克规则不变量)
   - [6.1 行动顺序](#61-行动顺序)
   - [6.2 断线坐出 (Sitting Out)](#62-断线坐出-sitting-out)
7. [关键流程](#7-关键流程)
   - [7.1 房间创建](#71-房间创建)
   - [7.2 玩家加入与重连](#72-玩家加入与重连)
   - [7.3 一手牌的完整生命周期](#73-一手牌的完整生命周期)
   - [7.4 每日重置](#74-每日重置)
   - [7.5 房间过期](#75-房间过期)
8. [测试](#8-测试)
9. [部署与运维](#9-部署与运维)
10. [已知问题与设计决策](#10-已知问题与设计决策)

---

## 1. 概览

**poker-scorer** 是一个实时德州扑克**计分器**（不发牌、不洗牌，只记筹码/盲注/行动轮转）。物理牌桌上的人打牌，本应用负责记录每手牌的筹码流动、盲注轮转和行动顺序。

| 属性 | 值 |
|------|-----|
| 运行时 | Cloudflare Workers Free Tier |
| 存储 | Durable Object SQLite Storage（每房间一个 DO） |
| 通信 | WebSocket（Hibernation API） |
| 前端 | 零构建 ES Module + 原生 CSS，PWA |
| 语言 | TypeScript（后端）/ JavaScript ES Module（前端） |
| 测试 | Vitest + @cloudflare/vitest-pool-workers |
| 部署 | `wrangler deploy`（无 CI/CD） |

**容量限制（Free Tier）**：
- 每个 DO 最多 1000 个 WebSocket 连接（实际每房 ≤12 玩家）
- SQLite 存储有限（游戏状态 JSON < 10KB/房）
- 每天 100,000 请求限额
- 单房串行化（DO 保证同一房间内的操作顺序执行）

---

## 2. 架构

```
┌─────────────────────────────────────────────────┐
│                  Cloudflare Workers              │
│                                                  │
│  ┌──────────────┐    ┌───────────────────────┐  │
│  │  index.ts    │───▶│  ASSETS (Static Files) │  │
│  │  (Router)    │    └───────────────────────┘  │
│  │              │                                │
│  │  POST /api/  │    ┌───────────────────────┐  │
│  │  rooms ──────┼───▶│  RoomRegistry DO     │  │
│  │              │    │  (房号唯一性)          │  │
│  │  /api/rooms/ │    └───────────────────────┘  │
│  │  :id/* ──────┼───┐                            │
│  │              │   │  ┌───────────────────────┐ │
│  │  /ws/:id ────┼───┼─▶│  GameRoom DO         │ │
│  └──────────────┘   │  │  (每房间一个实例)      │ │
│                      │  │  - SQLite 存储状态    │ │
│                      │  │  - WebSocket 管理     │ │
│                      │  │  - 全部游戏逻辑      │ │
│                      │  └───────────────────────┘ │
│                      │                            │
│                      │  房间间完全独立，横向扩展   │
│                      └────────────────────────────│
└─────────────────────────────────────────────────┘
```

**核心设计原则**：
1. **瘦客户端**：前端不做游戏逻辑判决，只渲染后端传来的 `currentPlayerIndex` 和 `PublicGameState`
2. **单房间串行**：GameRoom DO 保证同一房间内所有操作顺序执行，天然无竞态
3. **WebSocket Hibernation**：DO 在无消息时休眠以节省成本；通过 `serializeAttachment` 在 WebSocket 上存储 `playerId` 来保持连接间的玩家身份

---

## 3. 目录结构

```
poker-scorer/
├── src/                          # 后端 TypeScript（Cloudflare Worker）
│   ├── index.ts                  # Worker 入口 & HTTP 路由
│   ├── game-room.ts              # GameRoom Durable Object（核心游戏逻辑，~833行）
│   ├── room-registry.ts          # RoomRegistry Durable Object（房号注册，~25行）
│   ├── types.ts                  # 类型定义、常量、工具函数（~134行）
│   └── env.ts                    # Cloudflare 环境绑定类型
│
├── public/                       # 前端静态资源（零构建）
│   ├── index.html                # 单页面 HTML（3个视图）
│   ├── styles.css                # 全局样式（CSS 变量 + 响应式）
│   ├── sw.js                     # Service Worker（PWA 离线缓存）
│   ├── manifest.webmanifest      # PWA 清单
│   ├── scripts/
│   │   ├── app.js                # 应用入口，模块粘合，全局事件绑定
│   │   ├── socket.js             # WebSocket 生命周期管理（单例）
│   │   ├── render.js             # 纯渲染层（含与后端同源的局部逻辑）
│   │   ├── actions.js            # 玩家操作（fold/check/call/raise）
│   │   ├── ui.js                 # DOM 工具、toast、模态框、键盘适配
│   │   ├── storage.js            # localStorage 持久化（deviceId、玩家身份）
│   │   └── feedback.js           # 轮到你了通知（标题闪动、震动）
│   ├── assets/                   # 静态图片（hero、avatar、winner）
│   └── *.png                     # PWA 图标（gen-icons.mjs 生成）
│
├── test/
│   └── game-room.test.ts         # Vitest 测试（~708行，22 个用例）
│
├── scripts/
│   └── gen-icons.mjs             # PWA 图标生成脚本（依赖 sharp）
│
├── docs/                            # 项目文档
│   └── TECHNICAL.md                  #   本技术文档（唯一权威技术参考）
│
├── wrangler.toml                 # Cloudflare 部署配置
├── package.json                  # 依赖：hono + vitest + wrangler
├── tsconfig.json                 # TypeScript 配置（ES2022, strict）
├── tsconfig.test.json            # 测试专用 TS 配置
├── vitest.config.mts             # Vitest 配置（Cloudflare workers pool）
├── worker-configuration.d.ts     # 自动生成的 Worker 绑定类型（.gitignore 忽略）
└── README.md                     # 项目说明
```

---

## 4. 后端详解

### 4.1 入口路由 (index.ts)

**文件**：`src/index.ts`（102 行）

**职责**：HTTP 请求路由分发。

**处理顺序**（按优先级）：

| 匹配条件 | 方法 | 处理方式 |
|----------|------|----------|
| `POST /api/rooms` | POST | 创建新房间：生成房号 → 注册到 RoomRegistry → 初始化 GameRoom |
| `/api/rooms/:roomId/*` | 任意 | 检查房间存在 → 转发给对应 GameRoom DO |
| `/ws/:roomId` | 任意 | 检查房间存在 → WebSocket 升级到 GameRoom DO |
| 其他 | GET | `env.ASSETS.fetch(request)` 回退到静态文件 |

**关键细节**：

- **房号正则**：`/^\/api\/rooms\/([A-Z2-9]{6})/` —— **排除 0 和 1**（避免与字母 O/I 混淆）。房号来自 `generateRoomCode()` 使用的字符集 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
- **创建房间**：最多尝试 8 次生成不重复房号（`RoomRegistry.claim()` 原子操作），失败返回 503
- **房间存在检查** (`roomExists`)：先查 RoomRegistry；若未注册（兼容升级前的旧房间）则回退查 GameRoom 的 `/exists` 端点
- **非法房号**（含 0/1）：不匹配正则，落到 `env.ASSETS.fetch()` → 返回 1101 错误（Static Assets 找不到该文件）

**房间过期守卫**：`roomExists()` 同时检查 `expiresAt`，过期房间返回 404

### 4.2 类型与常量 (types.ts)

**文件**：`src/types.ts`（134 行）

#### Player 接口

```typescript
interface Player {
  id: string;              // UUID，客户端生成
  name: string;            // 玩家昵称
  chips: number;           // 当前筹码
  position: number;        // 相对庄位: 0=Dealer, 1=SB, 2=BB, 3=UTG...
  isFolded: boolean;       // 已弃牌
  isActive: boolean;       // 本手牌是否参与（在线+有筹码）
  isAllIn: boolean;        // 已全下
  isSittingOut: boolean;   // 断线坐出（保留座位但跳过行动）⚠️ 核心不变量见 §6.2
  currentBet: number;      // 当前轮下注额
  totalBet: number;        // 整手牌总下注额
  hasActedThisRound: boolean; // 本轮是否已行动
  isConnected: boolean;    // WebSocket 是否在线
}
```

#### Round 类型

```typescript
type Round = 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
```

`waiting` = 牌局间等待状态；`showdown` = 摊牌选胜者。

#### 消息协议

```typescript
// 客户端 → 服务端
interface ClientMessage {
  type: 'join' | 'leave' | 'action' | 'startHand' | 'nextRound' | 'endHand' | 'updateSettings' | 'ping';
  name?: string;
  playerId?: string;       // 重连用
  deviceId?: string;       // 设备标识，用于跨标签页身份恢复
  action?: Action;         // fold | check | call | raise
  amount?: number;         // 加注金额
  winnerIds?: string[];    // 摊牌选胜者
  settings?: { smallBlind?: number; bigBlind?: number };
}

// 服务端 → 客户端
interface ServerMessage {
  type: 'state' | 'error' | 'pong';
  state?: PublicGameState;
  message?: string;
}
```

#### PublicGameState vs GameState

- `GameState`：服务端完整状态，包含 `playerDevices: Record<string, string>`（deviceId 映射，**不发送给客户端**）
- `PublicGameState`：广播给客户端的状态，**不包含** `playerDevices`。额外包含 `yourPlayerId` 字段（每个连接收到的值不同）

#### 常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `DEFAULT_CHIPS` | 1000 | 初始筹码 |
| `DEFAULT_SMALL_BLIND` | 10 | 默认小盲 |
| `DEFAULT_BIG_BLIND` | 20 | 默认大盲 |
| `ROOM_TTL_MS` | 604,800,000（7 天） | 房间过期时间 |

#### 工具函数

- `generateRoomCode()`：`crypto.getRandomValues` 生成 6 位房号（32 字符集）
- `getRoundName(round)`：返回中文轮次名称

### 4.3 游戏房间 DO (game-room.ts)

**文件**：`src/game-room.ts`（833 行，最核心文件）

#### 初始化

```
constructor()
  └─ ctx.blockConcurrencyWhile(async () => {
       从 SQLite 恢复 game 状态
       重建 connections Map（从 Hibernation attachment）
       恢复玩家的 isConnected 状态
       执行 checkDailyReset()
       确保 alarm 已设置
     })
```

`blockConcurrencyWhile` 保证：在所有存储读取完成前，不处理任何请求。

#### 方法全景图

```
HTTP 入口
├── fetch()              # 路由 /exists, /state, /init, WebSocket upgrade
│
WebSocket 生命周期
├── webSocketMessage()   # 消息分发（根据 ClientMessage.type）
├── webSocketClose()     # 断线处理 → markDisconnected()
├── webSocketError()     # 错误日志
│
玩家管理
├── handleJoin()         # 加入/重连（4种身份恢复路径）
├── handleLeave()        # 离开 → markDisconnected()
├── markDisconnected()   # 标记断线坐出（核心逻辑）
│
游戏操作
├── handleAction()       # fold/check/call/raise
├── handleStartHand()    # 开新一手牌
├── handleNextRound()    # 进入下一轮（preflop→flop→turn→river→showdown）
├── handleEndHand()      # 摊牌结束，分配底池
├── handleSettings()     # 修改盲注（仅 waiting 状态）
│
游戏逻辑辅助
├── postBlinds()         # 发盲注（含 SB≠BB 防御）
├── setFirstToAct()      # 确定本轮首动者 ⚠️ 核心不变量见 §6.1
├── advanceTurn()        # 移动到下一位可行动玩家
├── isRoundComplete()    # 判断本轮下注是否完成
├── nextActiveIndex()    # 找下一个活跃玩家
├── nextDifferentActiveIndex() # 找下一个活跃且 ≠exclude 的玩家（盲注防御用）
├── assignPositions()    # 按庄位分配 position 编号
├── awardPot()           # 分配底池给胜者
├── resetActedFlags()    # 加注后重置其他玩家的 hasActedThisRound
│
广播与通信
├── broadcast()          # 向所有连接发送 state 消息（每个连接收到自己的 yourPlayerId）
├── sendError()          # 单连接错误
├── sendToAll()          # 全员错误（以 error 类型发送）
├── playerIdFor()        # 从 connections Map 或 socket attachment 获取 playerId
│
生命周期
├── alarm()              # 房间过期清理
├── checkDailyReset()    # 北京时间凌晨 4 点重置
├── save()               # 持久化到 SQLite
├── loadOrCreate()       # 延迟初始化或创建新状态
```

#### handleJoin 重连收敛（4 种身份恢复路径）

```
                    ┌─ 有 existingPlayerId ─▶ 查 playerDevices 映射匹配 ─▶ 找到 player
                    │
ClientMessage ──────┼─ 无 playerId 但有 deviceId ─▶ 查 playerDevices 反向匹配 ─▶ 找到 player
  { name,           │
    playerId?,      ├─ 仍没找到 + round==='waiting' ─▶ 按 name + !isConnected 匹配
    deviceId? }     │
                    └─ 全部未匹配 + round==='waiting' + 人数<12 ─▶ 创建新玩家
```

**关键点**：
1. 重连时**先注册新连接再关闭旧连接**——保证 `webSocketClose` 回调中 `hasAnotherConnection=true`，不会误判离线
2. 手牌进行中重连：保持 `isSittingOut=true`，本手牌仍跳过，等下一手牌 `startHand` 才复活
3. waiting 状态重连：立即清除 `isSittingOut`，恢复 `isActive`

#### handleAction 操作处理

```
fold:  isFolded = true
check: 仅当 toCall === 0（无需跟注）
call:  仅当 toCall > 0，跟注 = min(toCall, chips)
raise: 加注额 = toCall + raiseAmount
       - 若 totalNeeded >= chips → All-in
       - 若 totalNeeded < chips → 正常加注（最小加注额 ≥ bigBlind）
       - 加注后：currentBet 更新 + resetActedFlags(raiserIndex)
```

**操作后**：检查剩余竞争者数量 → 仅剩 1 人则直接进入 showdown 并 awardPot。否则 advanceTurn → 检查 isRoundComplete。

#### isRoundComplete 逻辑

```typescript
// 可行动者 = 未弃牌 + 活跃 + 未All-in + 未坐出
const actionable = players.filter(
  p => !p.isFolded && p.isActive && !p.isAllIn && !p.isSittingOut
);
// 所有人都已行动 且 所有人的 currentBet 都等于全局 currentBet
return actionable.every(p => p.hasActedThisRound && p.currentBet === this.game.currentBet);
```

**⚠️ 此逻辑在 `render.js` 中有副本，修改时必须同步。**

#### advanceTurn 逻辑

```typescript
// 从 currentPlayerIndex 开始循环，找第一个满足条件者：
// !isFolded && isActive && !isAllIn && !isSittingOut
// 找不到则设 -1（无人可行动）
```

**⚠️ 此谓词在 `render.js` 中也有副本。**

### 4.4 房间注册表 DO (room-registry.ts)

**文件**：`src/room-registry.ts`（25 行）

轻量 DO，仅用于房号唯一性：

```typescript
class RoomRegistry extends DurableObject {
  async claim(expiresAt: number): Promise<boolean>  // CAS 式注册，返回是否成功
  async exists(): Promise<boolean>                    // 检查是否已注册
  async remove(): Promise<void>                       // 删除注册
}
```

使用 SQLite 存储（`new_sqlite_classes`），`claim()` 内部逻辑：若已存在 → 返回 false；若不存在 → 写入 + 设置过期 alarm → 返回 true。

### 4.5 环境绑定 (env.ts)

```typescript
interface Env extends Cloudflare.Env {
  GAME_ROOM: DurableObjectNamespace<import('./game-room').GameRoom>;
  ROOM_REGISTRY: DurableObjectNamespace<import('./room-registry').RoomRegistry>;
  ASSETS: Fetcher;  // Workers Static Assets
}
```

---

## 5. 前端详解

### 5.1 HTML 结构

**文件**：`public/index.html`（单页面应用，三个视图 + 三个模态框）

```
view-home      # 首页：hero 图片 + 创建/加入房间
view-lobby     # 大厅：玩家列表 + 排行榜 + 开始按钮
view-game      # 牌局：顶栏 + 底池 + 公共牌 + 玩家卡片 + 行动栏

模态框（独立于视图，可叠加）：
#modal-name       # 输入昵称（加入/创建房间前）
#modal-share      # 分享房间码
#modal-winner     # 获胜者庆祝弹窗
```

**PWA 支持**：
- `manifest.webmanifest`：应用名 "PK · 德扑计分"
- `theme-color`：`#080b0a`
- viewport：`viewport-fit=cover`（iPhone 刘海屏适配）
- `apple-mobile-web-app-capable`：全屏模式

**事件绑定**：所有 `onclick` 通过 `window` 全局函数绑定（由 `app.js` 暴露）。

### 5.2 CSS 设计系统

**文件**：`public/styles.css`（~270 行）

**CSS 变量**（深色主题）：

```css
--bg: #080b0a           /* 近黑背景 */
--surface: #161a19       /* 卡片/面板 */
--accent: #d97757        /* 暖珊瑚色强调 */
--accent-dim: #a85d3f
--text-primary: #f0ede8  /* 暖白文字 */
--text-secondary: #9c9a95
--border: #2a2d2c
--danger: #dc5b4e
--success: #5b9d6b
--warning: #d4a44c
--table-green: #1a4a2e   /* 牌桌绿（行动按钮） */
```

**响应式断点**：
- `380px`：小屏手机
- `720px`：平板/桌面（最大宽度 480px 居中）
- `orientation: landscape`：横屏适配（减小间距）

**关键样式**：
- `.action-bar`：底部固定，flex 布局，响应 `.visible` 类控制显示
- `.player-card`：7 种视觉状态（active 绿色边框, folded 灰色透明度, sitting-out 黄色虚线, all-in 橙色, disconnected 红色, current-turn 发光动画, selected-winner 选中态）
- `.keyboard-open`：iOS 键盘弹出时 body class，用于固定定位修正
- `safe-area-inset-*`：iPhone 刘海/Home Indicator 安全区适配

### 5.3 JS 模块职责划分

7 个 ES Module（零构建，浏览器原生 import），无共享全局状态，通过函数参数/返回值通信：

#### app.js（284 行）— 应用入口

```
职责：模块粘合、状态路由、全局事件绑定
```

- **入口函数** `init()`：注册 SW → 绑定 onclick → 连接 socket 回调 → 处理 deep link
- **状态机**：`onState(state)` 根据 `round` 切换视图（waiting → lobby，其他 → game）
- **全局函数**（暴露到 `window`）：`createRoom`, `joinRoom`, `leaveTable`, `copyCurrentRoomCode`, `shareCurrentRoom`, `closeTopModal`, 游戏操作函数
- **事件委托**：`#action-bar` 上的 click 事件统一处理，根据 `data-action` 分发
- **键盘**：ESC 关闭顶层模态框
- **胜者庆祝**：`sessionStorage` 按 `handNumber` 去重，防止重复弹窗

#### socket.js（230 行）— WebSocket 管理器

```
职责：连接生命周期、心跳、自动重连
```

- **单例模式**：模块级 `let ws`, `let url`, `let playerId`
- **心跳**：`PING_INTERVAL = 60s`（发 ping），`PONG_TIMEOUT = 240s`（等 pong，~5min 窗口防后台误杀）
- **重连**：指数退避 2s→4s→8s…max 30s，`visiblitychange` 切回前台时立即尝试
- **订阅者模式**：`onConn`（Set）和 `onMessage`（Set）通知所有订阅者
- **身份持久化**：`playerId` 存 localStorage（由 `storage.js` 辅助）

#### render.js（220 行）— 渲染层

```
职责：纯渲染，读 PublicGameState → 更新 DOM（无状态变更）
```

- **三个渲染函数**：`renderLobby(state)`, `renderGame(state)`, `renderActionBar(state)`
- **Lobby**：玩家列表 + 排行榜（按筹码降序）+ 盲注设置
- **Game**：轮次标签（`getRoundName` 副本）+ 公共牌区 + 底池动画 + 玩家卡片
- **玩家卡片状态**：7 种视觉状态见 CSS 一节，位置标签 D/SB/BB/ALL
- **底池动画**：`requestAnimationFrame` + easeOutCubic，从旧值计数到新值
- **行动栏**：3 种模式 —— 轮到我（fold/check/call/raise）、本轮完成（进入下一轮按钮）、摊牌（选择胜者）
- ⚠️ **含与后端同源的逻辑**：`isRoundComplete()` 和 "可行动/候选获胜者" 过滤谓词（`!isSittingOut && !isAllIn`）

#### actions.js（105 行）— 玩家操作

```
职责：发送操作消息 + 客户端校验
```

- `sendAction(action, amount?)`：发送操作 → 震动反馈（`navigator.vibrate(15)`）
- **Fold 双击确认**：第一次点击 fold → 按钮变红 + "再点确认" + 2 秒超时后复原
- **Raise 控制**：步长 = `bigBlind`，最大值 = 玩家筹码，默认值 = min(toCall + bigBlind, chips)
- `startHand`, `nextRound`, `confirmWinners`（发送 `endHand`），`updateSettings`

#### ui.js（106 行）— DOM 工具

```
职责：DOM 快捷操作、toast、模态框、键盘适配
```

- `$(sel)`, `$$(sel)`：`querySelector` / `querySelectorAll` 别名
- `toast(message)`：居中叠加 toast，1.5s + 消息长度补偿自动消失
- `showView(id)`, `showModal(id)`, `closeModal(id)`, `closeTopModal()`
- `esc(text)`：HTML 转义
- `renderConnDot(connected)`：连接状态指示点（绿色/红色脉冲）
- `applyDeepLink()`：从 `?room=` URL 参数预填房间码
- `installKeyboardAdapter()`：iOS Visual Viewport API 处理键盘弹起

#### feedback.js（52 行）— 回合通知

```
职责：轮到你了的感官反馈
```

- **标题**：`document.title = '● 轮到你'`（后台标签页可见）
- **震动**：`[40, 60, 40]` 模式
- **音效**：已移除。Web Audio API 创建 AudioContext 后即使不播放，macOS/iOS 也会将页面识别为"媒体播放中"而抢占 AirPods

#### storage.js（33 行）— 本地持久化

```
职责：localStorage 读写
```

- `deviceId()`：生成/读取设备 UUID（用于跨标签页身份恢复）
- `getSavedPlayer(roomId)`：按房间读取玩家身份（含旧版 fallback 逻辑）
- `savePlayer(roomId, playerId, name)`：存储玩家身份

### 5.4 WebSocket 协议

#### 连接流程

```
客户端                               服务端
  │                                    │
  │──── ws://host/ws/ROOMID ──────────▶│  (HTTP Upgrade)
  │                                    │  acceptWebSocket + serializeAttachment({playerId:undefined})
  │◀─── 101 Switching Protocols ──────│
  │                                    │
  │──── {type:"join", name, playerId?, deviceId?} ──▶│
  │                                    │  handleJoin → broadcast(state)
  │◀─── {type:"state", state:{..., yourPlayerId}} ──│
  │                                    │
  │──── {type:"ping"} ────────────────▶│
  │◀─── {type:"pong"} ────────────────│
```

#### 消息类型汇总

| type | 方向 | 说明 |
|------|------|------|
| `join` | C→S | 加入房间（含 name, playerId?, deviceId?） |
| `leave` | C→S | 离开房间 |
| `action` | C→S | 操作（含 action: fold/check/call/raise, amount?） |
| `startHand` | C→S | 开始新一手牌 |
| `nextRound` | C→S | 进入下一轮 |
| `endHand` | C→S | 结束手牌，选胜者（含 winnerIds[]） |
| `updateSettings` | C→S | 修改盲注（含 settings: {smallBlind?, bigBlind?}） |
| `ping` | C→S | 心跳 |
| `state` | S→C | 状态同步（含 state: PublicGameState + yourPlayerId） |
| `error` | S→C | 错误消息（含 message: string） |
| `pong` | S→C | 心跳回复 |

#### 状态同步策略

- **全量推送**：每次状态变更 → `broadcast()` 向所有连接发送完整 `PublicGameState`
- **脏检查**：`webSocketMessage` 中用 `JSON.stringify(game)` 比较前后状态，有变化才 `save()`
- **逐连接定制**：`broadcast( yourPlayerId? )` 中每个连接收到的 `yourPlayerId` 不同（取自 `playerIdFor(ws)`）

### 5.5 前后端同源逻辑

以下逻辑在 `src/game-room.ts` 和 `public/scripts/render.js` 中**各有一份实现**，修改时必须同步：

| 逻辑 | 位置 | 说明 |
|------|------|------|
| `isRoundComplete()` | game-room.ts + render.js | 判断本轮下注是否完成 |
| 可行动者过滤 | advanceTurn + render.js | `!isFolded && isActive && !isAllIn && !isSittingOut` |
| 候选获胜者过滤 | handleEndHand 隐含 + render.js | 未弃牌者都可以是胜者 |
| 位置标签计算 | assignPositions + render.js | D=0, SB=1, BB=2 |

---

## 6. 扑克规则不变量

> ⚠️ **动手前必读。这些规则曾因误解被反复改错。修改先读本节。**

### 6.1 行动顺序

**座位**：`position` 0=庄家(D) / 1=小盲(SB) / 2=大盲(BB) / 3=UTG…

**多玩家（≥3）**：
- 翻牌前首动 = UTG（BB 下家）= `nextActiveIndex(nextActiveIndex(nextActiveIndex(dealer)))`
- 翻牌后 (flop/turn/river) 首动 = SB = `nextActiveIndex(dealer)`

**单挑（2 玩家，heads-up）**：
- 庄家即 SB（庄家在盲注位）
- 翻牌前首动 = SB(=庄家) = `dealerIndex`
- 翻牌后首动 = BB = `nextActiveIndex(dealer)`

> ⚠️ **单挑翻牌后"大盲先动"是标准德州规则，不是 bug。** 曾被误当 bug 改成"永远小盲先动"又回退。

**实现位置**：`game-room.ts` → `setFirstToAct()`

### 6.2 断线坐出 (Sitting Out)

> ⚠️ **这是刻意设计，不是 bug。** 早期版本断线即 fold、活跃环收缩，导致 SB/BB 塌缩到一人 + 一人独胜，已修复。

**断线玩家在本手牌内的行为**：

| 属性 | 行为 |
|------|------|
| 座位 | ✅ 保持，不收缩 |
| 盲注位次 | ✅ 保持，不影响下家判定 |
| 底池权益 | ✅ 保留（未弃牌者仍争夺底池） |
| 行动权 | ❌ 纯跳过（`advanceTurn` 跳过 `isSittingOut`） |
| 筹码 | ❌ 不消耗（不 fold 不付筹码） |
| 获胜条件 | ❌ 不因断线而出局 |

**复活时机**：
- 手牌进行中重连 → 仍保持 `isSittingOut=true`，等下一手牌
- 等待状态（`waiting`）重连 → 立即清除 `isSittingOut`，恢复 `isActive`
- 下一手牌 `startHand` → `isSittingOut = !isConnected`（在线则清除，离线则继续挂机）

**关键谓词**（三处）：
```typescript
// "可行动"判定（advanceTurn / isRoundComplete / setFirstToAct）
!isFolded && isActive && !isAllIn && !isSittingOut

// "仍在争夺底池"（handleAction 中判断是否只剩一人）
!isFolded  // 注意：不含 isSittingOut —— 断线者仍算争夺者！
```

**实现位置**：`game-room.ts` → `markDisconnected()`, `advanceTurn()`, `isRoundComplete()`, `setFirstToAct()`, `handleAction()`

---

## 7. 关键流程

### 7.1 房间创建

```
POST /api/rooms
  │
  ├─ 1. 解析请求体（可选的 smallBlind, bigBlind）
  ├─ 2. 最多 8 次尝试：
  │     generateRoomCode() → RoomRegistry.claim(expiresAt)
  │     成功 → 跳出循环
  ├─ 3. 获取 GameRoom DO stub (env.GAME_ROOM.getByName(roomId))
  ├─ 4. 调用 GameRoom.fetch('/init', {method:'POST', body:{expiresAt,...}})
  │     └─ loadOrCreate → 初始化 GameState → 设置 alarm
  ├─ 5. 返回 { roomId, smallBlind, bigBlind }
  │
  └─ 失败：回滚 RoomRegistry.remove(roomId)
```

### 7.2 玩家加入与重连

```
WebSocket 连接建立
  │
  └─ webSocketMessage({type:'join', name, playerId?, deviceId?})
       │
       ├─ 路径1: playerId 匹配 playerDevices 映射 → 重连
       ├─ 路径2: deviceId 反向匹配 playerDevices → 重连
       ├─ 路径3: waiting 状态 + name + !isConnected → 重连
       └─ 路径4: 全新加入（需 waiting 状态 + 人数<12）
            │
            └─ 创建新 Player + 写入 playerDevices 映射
       │
       └─ broadcast(yourPlayerId)
```

**重连正确性保证**：
1. 先注册新连接（`connections.set(ws, playerId)` + `serializeAttachment`）
2. 再关闭旧连接（`socket.close(1000, '已在新连接中恢复')`）
3. 旧连接的 `webSocketClose` 回调中 `hasAnotherConnection = true` → 不触发 `markDisconnected`

### 7.3 一手牌的完整生命周期

```
waiting
  │  handleStartHand()
  │  ├─ 过滤活跃玩家（isConnected && chips > 0），需 ≥2 人
  │  ├─ 移动 dealer（上一手牌后下移一位）
  │  ├─ 清除所有玩家手牌状态（fold/all-in/bets 归零）
  │  ├─ isSittingOut = !isConnected（在线复活，离线挂机）
  │  ├─ assignPositions()（按 dealer 起点分配位置编号）
  │  └─ postBlinds() + setFirstToAct()
  ▼
preflop
  │  玩家轮流操作（handleAction: fold/check/call/raise）
  │  └─ isRoundComplete() → handleNextRound()
  ▼
flop (3 张公共牌)
  │  同 preflop
  ▼
turn (4 张公共牌)
  │  同 preflop
  ▼
river (5 张公共牌)
  │  同 preflop
  ▼
showdown
  │  等待玩家选择获胜者
  │  └─ handleEndHand(winnerIds) → awardPot()
  ▼
waiting（循环）
```

**中途结束**：任何时候若 `!isFolded` 的玩家只剩 1 人 → 直接进入 showdown → `awardPot`

### 7.4 每日重置

**触发时机**：每次 `fetch()` 调用前，`checkDailyReset()` 检查日期是否变化。

**日期计算**：北京时间（Asia/Shanghai），**边界为凌晨 4:00**。实现方式：用 `Date.now() - 4*60*60*1000` 调整，然后格式化 `yyyy-MM-dd`。

**重置行为**：清空所有玩家，回到 `waiting` 状态，保留 `roomId` 和 `expiresAt`。

### 7.5 房间过期

```
alarm 触发（7 天 TTL）
  │
  ├─ 关闭所有 WebSocket 连接（close code 1000, reason '房间已过期'）
  ├─ RoomRegistry.remove(roomId)
  └─ ctx.storage.deleteAll()
```

---

## 8. 测试

**文件**：`test/game-room.test.ts`（707 行，22 个测试用例）

**框架**：Vitest + `@cloudflare/vitest-pool-workers`（Miniflare 模拟环境）

**辅助类**：`TestSocket` 封装 WebSocket 连接：
- `send(msg)`：发送 JSON 消息
- `waitForState()`：等待下一个 `state` 消息并返回 `PublicGameState`
- `waitForError()`：等待错误消息
- `expectError(msg)`：断言收到指定错误

**测试结构**（7 个 describe 块）：

| 测试组 | 用例数 | 覆盖内容 |
|--------|--------|----------|
| 基础流程 | 4 | 创建房间、12人上限、游戏中拒绝加入、WebSocket 直连 |
| 手牌流程 | 2 | 2人桌完整一手牌、3人桌 UTG 先动 |
| 极限与异常 | 7 | 重复操作、断线语义、零筹码、All-in、盲注修改拒绝、nextRound 校验、turn 进入 |
| 每日重置 | 1 | 日期字符串比较 |
| 并发重连与盲注防御 | 2 | SB≠BB 保证、重连不误判离线 |
| 断线坐出语义 | 4 | 跳过行动、不提前获胜、手牌中重连仍坐出、下局复活 |
| 房间目录与过期 | 5 | 404、API 创建、deviceId 重连、alarm 清理、exists 检测 |

**运行**：
```bash
npm test                    # vitest run
npx vitest run --reporter=verbose  # 详细输出
```

**已知问题**：Cloudflare vitest pool 在沙箱中启动可能 ~90s 超时。替代方案：将 `setFirstToAct/advanceTurn/postBlinds/nextActiveIndex` 原样抄进纯 Node `.mjs` 文件跑模拟。

---

## 9. 部署与运维

### 部署命令

```bash
npx wrangler deploy    # 部署到 Cloudflare Workers
```

**注意**：
- 无热更新，每次后端改动都需要重新部署
- DO 房间状态跨部署保留，进行中的手牌不回填状态，**下一手/下一轮**才走新代码
- 部署后记录 `Current Version ID`

### 本地开发

```bash
npm run dev     # wrangler dev（本地模拟）
npm run tail    # wrangler tail（线上日志流）
```

### 配置

**wrangler.toml**：
```toml
name = "poker-scorer"
main = "src/index.ts"
compatibility_date = "2026-06-20"

[assets]
directory = "./public"
binding = "ASSETS"

[[durable_objects.bindings]]
name = "GAME_ROOM"
class_name = "GameRoom"

[[durable_objects.bindings]]
name = "ROOM_REGISTRY"
class_name = "RoomRegistry"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["GameRoom"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["RoomRegistry"]

[observability]
enabled = true
head_sampling_rate = 1
```

**⚠️ 必须保持 `new_sqlite_classes`**：Free Tier 只支持 SQLite-backed DO。改回 `new_classes` 会破坏运行。

### 线上自测

```bash
# 创建房间
curl -X POST https://<worker>/api/rooms
# → { "roomId": "ABC234", "smallBlind": 10, "bigBlind": 20 }

# 查询状态
curl https://<worker>/api/rooms/ABC234/state
# → PublicGameState JSON

# 检查存在
curl https://<worker>/api/rooms/ABC234/exists
# → { "exists": true, "roomId": "ABC234" }

# 非法房号（含 0/1）→ 落到 ASSETS 报 1101，正常行为
```

### 日志

```bash
npx wrangler tail    # 实时日志流
```

---

## 10. 已知问题与设计决策

### 已知问题

| ID | 问题 | 影响 | 状态 |
|----|------|------|------|
| A1 | 单人存活时需手动选胜者 | 不自动 awardPot，需点"摊牌选胜者" | 未修复 |
| A2 | raise 最小加注检查在 currentBet=0 时可被绕过 | 翻牌后首次加注可能低于 bigBlind | 未修复 |
| A3 | waiting 中断线不移除玩家 | 离线者占座不退出（与文档描述不一致） | 设计如此 |
| A4 | 无"房主"概念 | 任何人都能 startHand/endHand/updateSettings | 设计如此 |
| A5 | waiting 中断线不自动重连 | 需手动刷新 | 未修复 |
| B1 | `normalizeDealerIndex()` 未被调用 | 死代码 | 未清理 |
| B2 | `lastActor` 字段冗余 | 与 `lastAction` 重复 | 未清理 |
| B3 | `JSON.stringify` 脏检查每次执行两次 | 性能微损耗 | 可接受 |
| B4 | RoomRegistry 过期清理依赖 alarm | 不活跃的房间注册表可能残留在 SQLite | 可接受 |

> 注：`worker-configuration.d.ts`(542KB) 和 `.DS_Store` 已加入 `.gitignore`，不会进入版本库。

### 核心设计决策

1. **瘦客户端**：前端不做游戏逻辑判决，只渲染后端状态。确保单一事实来源。
2. **全量状态同步**：每次状态变更 broadcast 完整 `PublicGameState`。简单可靠，状态 < 10KB。
3. **断线=坐出≠弃牌**：防止一人断线导致另一人独赢。详见 §6.2。
4. **无身份认证**：通过 `deviceId`（localStorage UUID）+ `playerId` 做设备级身份恢复，无密码。
5. **单房间串行**：利用 DO 的天然串行保证，避免分布式锁。

---

## 附录 A：文件依赖图

```
src/index.ts
  ├── src/types.ts (generateRoomCode, ROOM_TTL_MS)
  ├── src/env.ts (Env 类型)
  ├── src/game-room.ts (GameRoom DO 类，通过 export 暴露给 wrangler)
  └── src/room-registry.ts (RoomRegistry DO 类，通过 export 暴露给 wrangler)

src/game-room.ts
  ├── src/types.ts (全部类型和常量)
  └── src/env.ts (Env 类型)

public/scripts/app.js
  ├── socket.js (connect, disconnect, send, onConn, onMessage)
  ├── render.js (renderLobby, renderGame, renderActionBar)
  ├── actions.js (sendAction, startHand, nextRound, confirmWinners, updateSettings)
  ├── ui.js ($, $$, toast, showView, showModal, closeModal, closeTopModal, esc, renderConnDot, applyDeepLink)
  ├── storage.js (deviceId, getSavedPlayer, savePlayer)
  └── feedback.js (notifyTurn)

public/index.html
  ├── styles.css
  ├── scripts/app.js (type="module")
  └── sw.js 注册
```

## 附录 B：关键修改热力图

```
                    ┌── 修改频率最高 ──┐
src/game-room.ts   ████████████████████  (全部游戏逻辑)
src/types.ts       ████████              (类型/常量变更)
src/index.ts       ████                  (路由变更)
test/...           ████████              (跟随 game-room 变更)
render.js          ██████                (需与后端同步)
actions.js         ███                   (操作 UI 变更)
app.js             ███                   (事件绑定变更)
socket.js          ██                    (连接策略变更)
其余文件           █                     (低频变更)
```

**经验法则**：改 `game-room.ts` → 必跑全部测试；改 `setFirstToAct/advanceTurn/postBlinds/isRoundComplete` → 必验证行动顺序；改 `isSittingOut` 相关 → 必验证断线场景；改 `render.js` → 必检查与后端谓词一致。
