# poker-scorer 技术文档

> 德扑积分器 — 完整架构与实现参考  
> 配套入口：[README.md](../README.md) · 风险与改进：[RISKS_AND_IMPROVEMENTS.md](./RISKS_AND_IMPROVEMENTS.md)  
> 以仓库当前代码为准；改核心逻辑后请同步更新本文。

---

## 目录

1. [概览](#1-概览)
2. [架构](#2-架构)
3. [目录与文件职责](#3-目录与文件职责)
4. [后端](#4-后端)
5. [前端](#5-前端)
6. [WebSocket 协议](#6-websocket-协议)
7. [扑克规则不变量](#7-扑克规则不变量)
8. [关键流程](#8-关键流程)
9. [前后端同源逻辑](#9-前后端同源逻辑)
10. [测试](#10-测试)
11. [部署与运维](#11-部署与运维)
12. [设计决策与已知局限](#12-设计决策与已知局限)
13. [修改安全地图](#13-修改安全地图)

---

## 1. 概览

**poker-scorer** 是部署在 Cloudflare Workers 上的实时德州扑克**计分器**：

- 不发牌、不洗牌、不计算牌力。
- 记录：筹码、盲注、行动轮转、底池、主池/边池结算。
- 胜负由物理牌桌上的人在摊牌 UI 里按牌力排名选出。

| 属性 | 值 |
|------|-----|
| 运行时 | Cloudflare Workers Free Tier |
| 状态存储 | 每房间一个 SQLite-backed Durable Object `GameRoom` |
| 房号目录 | Durable Object `RoomRegistry` |
| 实时通道 | WebSocket + Hibernation API |
| 前端 | 零构建 ES Module + CSS，PWA |
| 语言 | 后端 TypeScript / 前端原生 JS |
| 测试 | Vitest + `@cloudflare/vitest-pool-workers` |
| 部署 | `wrangler deploy`，无 CI/CD |

**容量直觉（以平台当前 Free Tier 为准，部署前查官方文档）**

- 每房玩家上限 12；每 DO WebSocket 连接上限远高于此。
- 单房状态 JSON 通常 < 10KB。
- 房间内操作由 DO 串行，无跨请求竞态；房间之间横向扩展。

---

## 2. 架构

```
┌──────────────────────────────────────────────────────────┐
│                   Cloudflare Worker                       │
│                                                          │
│  src/index.ts  (路由)                                     │
│    │                                                     │
│    ├─ POST /api/rooms ─────────► RoomRegistry.claim()    │
│    │                              + GameRoom /init       │
│    │                                                     │
│    ├─ /api/rooms/:id/* ────────► GameRoom DO             │
│    ├─ /ws/:id ─────────────────► GameRoom DO (WS upgrade)│
│    │                                                     │
│    └─ 其他 GET ────────────────► ASSETS (public/)        │
│                                                          │
│  GameRoom（每房间一个实例）                                 │
│    · SQLite storage 持久化 GameState                      │
│    · Hibernation WebSocket，attachment 存 playerId       │
│    · 全部游戏逻辑串行执行                                   │
│    · alarm：北京 04:00 清理 或 7 天 TTL 销毁               │
└──────────────────────────────────────────────────────────┘
```

### 设计原则

1. **瘦客户端**：前端不判行动权，只渲染 `currentPlayerIndex` 与 `PublicGameState`。
2. **单房串行**：`GameRoom` DO 保证同一房间操作顺序执行。
3. **Hibernation**：无消息时可休眠；`serializeAttachment({ playerId })` 在唤醒后恢复身份映射。
4. **全量状态同步**：每次变更 `broadcast` 完整公开状态（体积小、实现简单）。
5. **无账号体系**：`deviceId`（localStorage UUID）+ `playerId` 做设备级身份恢复。

---

## 3. 目录与文件职责

```
poker-scorer/
├── src/
│   ├── index.ts           # Worker 入口与路由（~100 行）
│   ├── game-room.ts       # 核心：游戏 + WS + 结算 + 生命周期（~1110 行）
│   ├── room-registry.ts   # 房号 CAS 注册（~25 行）
│   ├── types.ts           # 类型、常量、generateRoomCode / getRoundName
│   └── env.ts             # Env extends Cloudflare.Env（绑定由 wrangler 生成）
├── public/
│   ├── index.html         # 三视图 + 三模态框
│   ├── styles.css         # 设计系统
│   ├── sw.js              # 壳缓存 PWA
│   ├── manifest.webmanifest
│   ├── scripts/
│   │   ├── app.js         # 入口：粘合模块、事件委托、庆祝弹窗
│   │   ├── socket.js      # WS 生命周期 / 心跳 / 重连 / sync
│   │   ├── render.js      # 纯渲染 + 摊牌分档 UI + 同源 isRoundComplete
│   │   ├── actions.js     # 发操作消息、弃牌二次确认、加注、补码
│   │   ├── ui.js          # DOM、toast、modal、深链、键盘适配
│   │   ├── storage.js     # deviceId / 房间玩家身份
│   │   └── feedback.js    # 轮到你：标题 + 横幅 + 震动
│   └── assets/、图标 png
├── test/game-room.test.ts
├── scripts/gen-icons.mjs  # PWA 图标生成（可选，依赖 sharp）
├── wrangler.toml
├── package.json
├── vitest.config.mts
└── docs/TECHNICAL.md      # 本文件
```

### 修改热力图

| 文件 | 频率 / 风险 |
|------|-------------|
| `src/game-room.ts` | 最高：任何规则改动都在这里 |
| `src/types.ts` | 协议字段变更时改 |
| `public/scripts/render.js` | 中：含同源谓词，改后端必同步 |
| `public/scripts/actions.js` / `app.js` | UI 操作流 |
| `public/scripts/socket.js` | 连接策略 |
| `test/game-room.test.ts` | 跟随 game-room |

---

## 4. 后端

### 4.1 路由 `src/index.ts`

处理顺序：

| 匹配 | 行为 |
|------|------|
| `POST /api/rooms` | 最多 8 次 `generateRoomCode` + `RoomRegistry.claim` → `GameRoom /init` → 返回 `{ roomId, smallBlind, bigBlind }`；失败回滚 registry |
| `/api/rooms/:id/*` | 房号须匹配 `^[A-Z2-9]{6}$`（无 0/1）→ `roomExists` → 转 DO |
| `/ws/:id` | 同上，转 DO 做 WebSocket 升级 |
| 其他 | `env.ASSETS.fetch` 静态资源 |

`roomExists`：先查 `RoomRegistry`；未注册则兼容旧房：读 `GameRoom /exists`，用 `createdAt + ROOM_TTL_MS` 判断，有效则补写 registry。

非法房号（含 0/1）不进正则 → 落到 ASSETS → 常见 1101，**不是服务端逻辑故障**。

### 4.2 类型 `src/types.ts`

#### Player

| 字段 | 含义 |
|------|------|
| `id` | UUID，服务端创建新玩家时生成 |
| `name` | 昵称 |
| `chips` | 当前筹码 |
| `position` | 相对庄：0=D, 1=SB, 2=BB, 3=UTG… |
| `isFolded` | 本手已弃牌 |
| `isActive` | 本手是否参与（开局时：在线且 chips>0 的快照） |
| `isAllIn` | 已全下 |
| `isSittingOut` | 断线坐出挂机（见 §7.2） |
| `currentBet` / `totalBet` | 本轮注 / 本手总投入（边池分层用 totalBet） |
| `hasActedThisRound` | 本轮是否已行动 |
| `isConnected` | WebSocket 是否在线 |
| `disconnectedAt?` | 断线时间戳，供前端显示离线时长 |

#### Round

`waiting | preflop | flop | turn | river | showdown`

#### GameState（仅服务端完整存储）

在公开字段之外还有：

- `playerDevices: Record<playerId, deviceId>` — **不下发客户端**
- `expiresAt` / `createdAt`
- `sidePots?` — 最近一次结算明细，结算后短暂存在，下一手清空
- `lastWinnerIds` — 庆祝弹窗用

#### 常量

| 常量 | 值 |
|------|-----|
| `DEFAULT_CHIPS` | 1000 |
| `DEFAULT_SMALL_BLIND` | 10 |
| `DEFAULT_BIG_BLIND` | 20 |
| `ROOM_TTL_MS` | 7 天 |

房号：`ABCDEFGHJKLMNPQRSTUVWXYZ23456789` 共 32 字符，长度 6。

### 4.3 RoomRegistry `src/room-registry.ts`

轻量 DO，SQLite 一条 `room: { expiresAt }`：

- `claim(expiresAt)`：已存在 → false；否则写入 → true（CAS）
- `exists()`：存在且未过期
- `remove()`：`deleteAll`

### 4.4 GameRoom `src/game-room.ts`

#### 初始化

`constructor` 内 `blockConcurrencyWhile`：

1. 读 `storage.get('game')`
2. 玩家 `isConnected=false`，无 `disconnectedAt` 则兜底为 `Date.now()`
3. `getWebSockets()` + attachment 恢复仍活着的连接
4. 若无 alarm 且有 game → `setAlarm(nextCleanupOrExpiry())`

#### HTTP `fetch`

| 路径 | 作用 |
|------|------|
| `GET .../exists` | `{ exists, createdAt }`；`expired` 时 false |
| `GET .../state` | `publicState()` |
| `POST .../init` | 设置盲注与 expiresAt，save + alarm |
| `Upgrade: websocket` | `acceptWebSocket`，101 |

#### WebSocket 消息分发

| type | 处理 |
|------|------|
| `join` | `handleJoin` |
| `leave` | `handleLeave` → `markDisconnected` |
| `action` | `handleAction` (fold/check/call/raise) |
| `startHand` | `handleStartHand` |
| `nextRound` | `handleNextRound` |
| `endHand` | `handleEndHand(tiers, winnerIds)` |
| `updateSettings` | 仅 waiting 改盲注 |
| `rebuy` | 仅 waiting 补码 |
| `removePlayer` | 仅 waiting 移除**离线**玩家 |
| `sync` | 不改状态，只 `broadcast`（切前台补状态） |
| `ping` | `pong`（不落盘） |

状态变更后用 `JSON.stringify` 脏检查再 `save()`。

#### 方法地图（按职责）

```
生命周期: constructor, loadOrCreate, save, alarm, nextCleanupMs, nextCleanupOrExpiry
玩家:     handleJoin, handleLeave, markDisconnected, handleRebuy, handleRemovePlayer
行动:     handleAction, resetActedFlags, advanceTurn, isRoundComplete
轮次:     handleStartHand, handleNextRound, setFirstToAct, postBlinds,
          shouldRunOutBoard, autoAdvanceToShowdown
结算:     handleEndHand, awardPotsByTiers, awardToSoloSurvivor, checkSoloSurvivor
位次:     assignPositions, nextActiveIndex, nextDifferentActiveIndex
通信:     broadcast, publicState, sendError, sendToAll, playerIdFor
设置:     handleSettings
```

#### handleJoin 身份恢复（4 条路径）

1. 带 `playerId`，且 `playerDevices` 与 `deviceId` 兼容 → 重连  
2. 无 playerId 但 `deviceId` 反查映射命中 → 重连  
3. `waiting` 且同名且 `!isConnected` → 重连  
4. `waiting` 且人数 <12 → 新建玩家（默认 1000 筹码）

重连关键：**先** `connections.set` + `serializeAttachment`，**再** 关旧 socket。这样旧连接 `webSocketClose` 里 `hasAnotherConnection===true`，不会误挂机。

- 手牌中重连：保持 `isSittingOut=true`  
- waiting 重连：清 `isSittingOut`，恢复 `isActive`（若未 fold）  
- 清 `disconnectedAt`

#### handleAction 要点

- 仅当前 `currentPlayerIndex` 且未 fold/all-in 可操作。
- `toCall = currentBet - player.currentBet`
- **raise**：  
  - 筹码不够 → all-in；若推高了 `currentBet` 且加注幅度 ≥ bigBlind 才 `resetActedFlags`（不足额 all-in **不完整重开**）。  
  - 非 all-in：**无条件** `raiseAmount >= bigBlind`。  
- 操作后：若 `!isFolded` 只剩 1 人 → `awardToSoloSurvivor`（直接结算进 waiting）。  
- 否则 `advanceTurn`；若 `isRoundComplete && shouldRunOutBoard` → `autoAdvanceToShowdown`。  
- 否则仅提示「本轮下注完成，请点下一轮」。

#### shouldRunOutBoard / autoAdvanceToShowdown

当争夺者 ≥2，但可行动人数 ≤1（全员 all-in 或只剩一人可行动）时，跳过无意义的逐街 check：

- `communityCards = 5`，`round = showdown`，仍需人手选胜。

#### 边池结算 `awardPotsByTiers(tiers)`

- `tiers[0]` = 第 1 名（可并列），`tiers[1]` = 第 2 名…  
- 兼容旧客户端：只发 `winnerIds` 时包装成单层 `[[...]]`。  
- 校验：id 存在、`!isFolded`、不跨档重复。  
- 算法：按 `totalBet` 升序分层；每层 `layerAmount * 贡献人数`。  
  - 该层无未弃牌合格者 → **退还**贡献者  
  - 仅 1 名合格且未在 tiers 覆盖 → **自动**归其  
  - ≥2 名合格且 tiers 未覆盖 → **拒绝**整次结算（两阶段规划，避免半结算）  
- 成功后 `pot=0`，写 `sidePots` / `lastWinnerIds` / `lastAction`，`round → waiting`。

#### 盲注 `postBlinds`

- 单挑：dealer = SB；多人：SB = dealer 下家（`nextActiveIndex`）  
- BB = SB 下家；强制 **SB ≠ BB**（`nextDifferentActiveIndex` 兜底）  
- 实付 `min(blind, chips)`；`currentBet = max(sbAmt, bbAmt)`（跟注对齐有效最高注；最小加注仍按 bigBlind）

#### setFirstToAct（最易改错）

| 场景 | 首动 |
|------|------|
| 多人 preflop | UTG = BB 的下家 = `nextActive×3(dealer)` |
| 多人 postflop | SB = `nextActive(dealer)` |
| 单挑 preflop | dealer(=SB) |
| 单挑 postflop | BB = `nextActive(dealer)` |

从 startIdx 起找第一个可行动者（四字段谓词）。

#### 每日清理与过期 `alarm`

- alarm 目标 = min(下一北京 04:00, expiresAt)  
- **TTL 未到且 round ≠ waiting**：绝不销毁，延后 15 分钟再查  
- waiting 下的每日清理 **或** TTL 到期：关所有 WS、`RoomRegistry.remove`、`storage.deleteAll`、标记 `expired`

北京 04:00 用 `Asia/Shanghai` 墙钟计算（`nextCleanupMs`），避开晚间牌局高峰。

#### rebuy / removePlayer

- 仅 `waiting`  
- rebuy：默认 +`DEFAULT_CHIPS`，上限单次 100000，可指定 `targetPlayerId`  
- removePlayer：只能移 `!isConnected` 的玩家；修正 `dealerIndex`

---

## 5. 前端

### 5.1 视图 `public/index.html`

| 视图 / 模态 | 内容 |
|-------------|------|
| `view-home` | 创建 / 加入 |
| `view-lobby` | 排行榜、玩家、盲注、开始、补码/移除 |
| `view-game` | 轮次、公共牌槽、底池、玩家、行动栏 |
| `name-modal` | 输入昵称 |
| `share-modal` | 分享房间码 |
| `winner-modal` | 你赢了的庆祝 |

PWA：`manifest.webmanifest` + `sw.js`（壳缓存 `pk-shell-v10`；API/WS 不拦截）。  
静态资源 query `?v=9` 做 cache bust。

### 5.2 模块

| 模块 | 职责 |
|------|------|
| `app.js` | init、消息路由、`onState`、操作栏/大厅事件委托、创建加入房间、胜者庆祝去重、SW 注册 |
| `socket.js` | 单例 WS；join 时带 playerId/deviceId；心跳 60s / pong 超时 240s；指数退避重连 max 30s；`visibilitychange` 发 `sync`+`ping` 或 `reconnectNow` |
| `render.js` | lobby/game/actionBar；`isMyTurn` / `isRoundComplete`；摊牌 `selectedTiers`；离线时长文案 |
| `actions.js` | fold 二次确认、raise 步进、all-in、endHand(tiers)、rebuy/remove |
| `ui.js` | `$`、toast、modal、深链 `?room=`、Visual Viewport 键盘适配 |
| `storage.js` | `pk_device_id`、`pk_players[roomId]` |
| `feedback.js` | 轮到你：title「● 轮到你」、横幅、震动；**无音效**（避免抢 AirPods） |

### 5.3 UI 行为摘要

- 弃牌需点两次（2s 超时撤销）  
- 加注 min 动态绑定 `bigBlind`；预览「加注 +X｜本次投入 Y｜线到 Z」  
- 全押按钮直接 `raise(chips)`  
- 摊牌：点玩家进当前档 →「下一档」→「确认结算」；可「上一档」撤销  
- 切后台再回来：活连接 `sync` 重推状态；死连接立即重连；成功 toast「已恢复连接」

### 5.4 CSS

深色主题变量：`--bg #080b0a`、`--accent #d97757`、`--table-green` 等。  
移动优先：safe-area、横屏、keyboard-open 时操作栏定位修正。

---

## 6. WebSocket 协议

### 连接

```
Client                         Server
  |--- WS /ws/ROOMID ---------->|  acceptWebSocket
  |--- join {name, playerId?, deviceId?} -->|
  |<-- state { state: PublicGameState + yourPlayerId } ---|
  |--- ping ------------------->|
  |<-- pong --------------------|
  |--- sync ------------------->|  (重推 state，不改 game)
```

### 客户端 → 服务端

| type | 主要字段 | 说明 |
|------|----------|------|
| `join` | name, playerId?, deviceId? | 加入/重连 |
| `leave` | | 主动离开 → 坐出 |
| `action` | action, amount? | fold/check/call/raise |
| `startHand` | | 开始新手 |
| `nextRound` | | 进下一街 |
| `endHand` | tiers? 或 winnerIds? | 摊牌结算 |
| `updateSettings` | settings.{smallBlind,bigBlind} | waiting |
| `rebuy` | amount?, targetPlayerId? | waiting |
| `removePlayer` | targetPlayerId | waiting，仅离线 |
| `sync` | | 请求重推 |
| `ping` | | 心跳 |

### 服务端 → 客户端

| type | 字段 |
|------|------|
| `state` | `state: PublicGameState`（每连接 `yourPlayerId` 不同） |
| `error` | `message` |
| `pong` | |

`PublicGameState` **不含** `playerDevices`。

---

## 7. 扑克规则不变量

> 动手改 `setFirstToAct` / `markDisconnected` / 谓词前必读。历史上有过「单挑翻牌后谁先动」和「断线=弃牌」两次严重回退。

### 7.1 行动顺序

- `dealerIndex`：players 数组下标  
- 「下家」：`nextActiveIndex`（仅看 `isActive`，本手位次环不因断线收缩）

**盲注**

- 多人：SB = dealer 下家，BB = SB 下家  
- 单挑：dealer = SB，另一人 = BB  
- 永远 SB ≠ BB

**首动**

| | preflop | flop/turn/river |
|--|---------|-----------------|
| ≥3 人 | UTG（BB 下家） | SB |
| 2 人 | SB（=庄家） | **BB** |

⚠️ 单挑翻牌后 BB 先动是标准 NLHE，不是 bug。

### 7.2 断线坐出（sitting-out）

断线玩家**在本手内**：

| 保持 | 不发生 |
|------|--------|
| 座位、isActive 位次环、底池权益（!isFolded） | fold、出局、付筹码、占用行动权 |

实现：`markDisconnected` 设 `isSittingOut=true` + `disconnectedAt`（waiting 时只离线不挂机）。

**谓词**

```text
可行动 = !isFolded && isActive && !isAllIn && !isSittingOut
  用于：advanceTurn / isRoundComplete / setFirstToAct / 前端 isMyTurn

争夺底池 = !isFolded
  用于：独胜检测、摊牌候选（含挂机！）
  禁止用 isSittingOut 把挂机者踢出争夺，否则「一人断线→另一人独赢」
```

**复活**

- 手牌中重连：仍挂机  
- waiting 重连：立即清挂机  
- `startHand`：`isSittingOut = !isConnected`

**独胜**

- `checkSoloSurvivor` / fold 后只剩一人：`awardToSoloSurvivor` → 结算后进 **waiting**（可直接开下一手）  
- 挂机者仍 `!isFolded`，因此不会因一人断线而独胜

### 7.3 下注规则（当前实现）

- 最小加注/开池下注增量：**≥ bigBlind**（开池与加注同一标准）  
- 不足额 all-in 不 `resetActedFlags`：已行动者只需补跟  
- 无 straddle；最小加注不是「上次加注额」

---

## 8. 关键流程

### 8.1 建房

```
POST /api/rooms
  → claim 房号（最多 8 次）
  → GameRoom POST /init { expiresAt, 可选盲注 }
  → { roomId, smallBlind, bigBlind }
```

### 8.2 一手牌生命周期

```
waiting
  handleStartHand
    活跃 = isConnected && chips>0（≥2）
    handNumber++，清 sidePots / lastWinnerIds
    移动 dealer（第二手起）
    清 fold/all-in/注；isSittingOut=!isConnected
    assignPositions → postBlinds → setFirstToAct
    若已 shouldRunOutBoard → 直接 showdown
    ▼
preflop → (行动循环) → isRoundComplete → 用户 nextRound 或 auto showdown
    ▼
flop (communityCards=3) → …
turn (4) → river (5) → showdown
    ▼
showdown：人手选 tiers → awardPotsByTiers → waiting
```

中途：只剩一人 `!isFolded` → 立即结算回 waiting。

### 8.3 房间销毁

- 北京 04:00 alarm + waiting → 销毁  
- 手牌中 → 推迟 15 分钟  
- `expiresAt`（创建 +7 天）→ 销毁  

---

## 9. 前后端同源逻辑

以下逻辑两端各有一份，**改一处必须改另一处**。

| 逻辑 | 后端 | 前端 |
|------|------|------|
| `isRoundComplete` | `game-room.ts` | `render.js` `isRoundComplete` |
| 可行动 / 是否轮到我 | `advanceTurn` / `setFirstToAct` | `render.js` `isMyTurn`、卡片 `isTurn` |
| toCall | `handleAction` | `renderActionBar` |
| D/SB/BB 标签 | `assignPositions` + postBlinds 位次 | `renderGame` 用 active 环推 SB/BB |
| 摊牌候选 | 校验 `!isFolded` | `!isFolded`（**含** sitting-out） |

修改协议建议：后端先改 → grep 前端同名表达式 → 补测 → 部署。

---

## 10. 测试

文件：`test/game-room.test.ts`  
框架：Vitest + Cloudflare workers pool（Miniflare）。

主要 describe：

| 组 | 覆盖 |
|----|------|
| 基础流程 | 建房、12 人上限、游戏中拒加入、WS 加入 |
| 手牌流程 | 2 人桌盲注与顺序、3 人 UTG 先动 |
| 极限与异常 | 重复操作、断线坐出、零筹码、all-in、盲注锁定、nextRound 校验 |
| 每日清理 | alarm 销毁房间与目录 |
| Side pot | 多路 all-in 分层、平手分池 |
| 并发重连 | SB≠BB、重连不误离线 |
| 断线坐出语义 | 跳过行动、不提前独胜、本手重连仍挂机 |
| 房间目录 | 404、exists、deviceId 重连、alarm 清理 |

```bash
npm test
npx tsc --noEmit
```

**注意**：部分沙箱里 vitest pool 启动可能很慢或超时。验证行动顺序时，可把 `setFirstToAct` / `advanceTurn` / `postBlinds` / `nextActiveIndex` 原样抄到纯 Node 脚本做 2/3/4 人模拟（不依赖 workers pool）。

---

## 11. 部署与运维

### wrangler.toml 要点

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
```

⚠️ **必须** `new_sqlite_classes`。Free Tier 不支持旧式 KV-backed DO。若历史上曾用 `new_classes` 创建过同名 namespace，Cloudflare **不会**原地转 SQLite，需在 Dashboard 删除旧 namespace（数据会丢）后再部署。

### 命令

```bash
npm run dev       # 本地
npm run deploy    # 生产；记录 Current Version ID
npm run tail      # 日志
```

后端无热更新；DO 状态跨版本保留。

### 线上地址

https://poker-scorer.1956133426lpy.workers.dev/

### 线上自测

```bash
curl -X POST https://poker-scorer.1956133426lpy.workers.dev/api/rooms
# → {"roomId":"ABC234","smallBlind":10,"bigBlind":20}

curl https://poker-scorer.1956133426lpy.workers.dev/api/rooms/ABC234/state
curl https://poker-scorer.1956133426lpy.workers.dev/api/rooms/ABC234/exists
```

### 前端 cache

改 `public/scripts/*` 或 CSS 后：同步 bump `index.html` / `sw.js` 里的 `?v=` 与 `CACHE` 名，否则 PWA 壳可能继续用旧脚本。

---

## 12. 设计决策与已知局限

### 决策

1. 计分器而非完整扑克引擎 → 摊牌人手选胜，实现边池用排名分档而非牌力计算。  
2. 断线=坐出≠弃牌 → 线下「去拿可乐」不应丢底池。  
3. 无房主 → 熟人局信任模型。  
4. 全量 broadcast → 状态小、调试简单。  
5. 每日 04:00 销毁空闲房 + 7 天 TTL → Free Tier 垃圾回收。  
6. 音效移除 → 系统会把页面当媒体播放源抢耳机。

### 局限 / 可改进点

| 项 | 说明 |
|----|------|
| 最小加注 | 固定 bigBlind，非「上次加注增量」 |
| 无 straddle | — |
| 无权限模型 | 任何人可 start/end/settings/rebuy/remove |
| 每日清理 | waiting 时**整房销毁**（不是只清筹码）；进行中会推迟 |
| 前端 raise input | HTML 默认 min=0，运行时由 render 设为 bigBlind；后端仍是最终校验 |
| `lastActor` | 与 `lastAction` 语义重叠，历史字段 |

历史上审计过的问题多数已在 2026-07 左右修复，包括：raise 在 currentBet=0 时的限额、边池/退还、全体 all-in 自动摊牌、winner 校验、BB 短码 currentBet、不足额 all-in 不重开、独胜后回 waiting、挂机可选胜、补码与移除离线者、切前台 sync 等。以**当前代码**为准，不要按旧审计文档假设未修。

---

## 13. 修改安全地图

### 改这些函数时必做

| 改动 | 必验 |
|------|------|
| `setFirstToAct` / `nextActiveIndex` | 2 人 preflop/postflop + 3/4 人 preflop/postflop 首动 |
| `markDisconnected` / sitting-out 谓词 | 断线不独赢、跳过行动、本手重连仍挂机、下局复活 |
| `isRoundComplete` / `advanceTurn` | 同步 `render.js` |
| `awardPotsByTiers` | 多路 all-in、平分、退还、未排满拒绝 |
| `postBlinds` | SB≠BB；单挑庄家=SB |
| 消息协议 / `types.ts` | 前后端字段与 `actions.js` 发送一致 |
| 每日 alarm | 手牌中不销毁；waiting 可清 |

### 依赖关系

```
types.ts
  ├── index.ts
  ├── game-room.ts ──► test/game-room.test.ts
  └── （前端无 TS import，靠协议约定）

public/scripts/app.js
  ├── socket.js → storage.js
  ├── render.js → ui.js
  ├── actions.js → socket.js, render.js, ui.js
  ├── feedback.js
  └── ui.js
```

### 经验法则

1. 改 `game-room.ts` → 跑测试 + typecheck，再 deploy。  
2. 改谓词 → 同步 `render.js`（及 `isMyTurn` 调用方）。  
3. 改静态资源 → bump cache version。  
4. 不要「顺手」把断线改回 fold，不要「修正」单挑翻牌后为 SB 先动。

---

## 附录：一手从用户视角的状态机

```
首页 create/join
  → 大厅 waiting（补码/改盲注/移除离线）
  → startHand → preflop
  → 行动… → [下一轮 | 自动摊牌]
  → flop / turn / river
  → showdown（选名次档）
  → 结算 → waiting
  → 循环或离开
```

断线：手牌中 → 挂机跳过；等待中 → 离线占座（可被移除）。  
房间：北京 04:00 空闲销毁，或 7 天 TTL。

---

读完本文与 [README](../README.md) 后，建议按这个顺序读代码以巩固：

1. `src/types.ts` — 状态长什么样  
2. `src/index.ts` — 请求怎么进房  
3. `src/game-room.ts` — `handleStartHand` → `postBlinds` → `setFirstToAct` → `handleAction` → `awardPotsByTiers`  
4. `public/scripts/socket.js` + `app.js` + `render.js` — 状态如何上屏  
5. `test/game-room.test.ts` — 不变量如何被锁住  
