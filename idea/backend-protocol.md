# 后端架构与 WebSocket 协议（前后端对接合同）

> **这是最重要的文件。** 前端要做的全部工作，就是用 React 组件呈现并驱动这套协议。
> 后端代码（`src/`）**一个字都不要改**。

---

## 1. 后端架构（现状，不要动）

```
src/
├── index.ts        # Worker 入口：路由 /api/rooms、/api/rooms/:id、/ws/:id，其余走静态资源
├── game-room.ts    # GameRoom Durable Object：全部游戏逻辑 + WebSocket 处理（约 720 行）
├── types.ts        # 类型定义 + 消息协议 + 工具函数（前端要复用其中的协议类型）
└── env.ts          # Cloudflare 环境绑定：GAME_ROOM(DO) + ASSETS(静态资源)
```

- 静态页面由 Workers Static Assets 提供（serve `./public`）。
- API 和 WebSocket 由 Worker 路由。
- **每个房间 = 一个独立的 SQLite-backed Durable Object**，房间内串行、房间间横向扩展。
- WebSocket 用 **Hibernation API**，玩家身份存 socket attachment；房间空闲可休眠。
- 每日按 Asia/Shanghai 自动重置房间。

### 路由（`src/index.ts`）
| 方法 & 路径 | 作用 |
|---|---|
| `POST /api/rooms` | 创建房间。body `{ smallBlind, bigBlind }`。返回 `{ roomId, smallBlind, bigBlind }` |
| `* /api/rooms/:roomId/*` | 透传给该房间的 Durable Object（如 `GET .../state`） |
| `WS  /ws/:roomId` | 升级为 WebSocket，连接到该房间 |
| 其余 | `env.ASSETS.fetch(request)`（serve 前端静态资源） |

### 部署约束（来自 README，务必遵守）
- `wrangler.toml` 必须用 `new_sqlite_classes = ["GameRoom"]`，**不要**改回 `new_classes`
  （后者是 KV-backed DO，Free Tier 不支持）。
- 若历史已存在 KV-backed `GameRoom` namespace，需先在 Dashboard 删除旧 namespace 再部署。

---

## 2. WebSocket 协议（合同）

连接：`wss://<host>/ws/<roomId>`（开发环境 `ws://`）。

### 2.1 客户端 → 服务端（`ClientMessage`）

```ts
type ClientMessage =
  | { type: 'join';          name: string; playerId?: string }
  | { type: 'leave' }
  | { type: 'action';        action: 'fold' | 'check' | 'call' | 'raise'; amount?: number }
  | { type: 'startHand' }
  | { type: 'nextRound' }
  | { type: 'endHand';       winnerIds: string[] }
  | { type: 'updateSettings'; settings: { smallBlind?: number; bigBlind?: number } }
  | { type: 'ping' };
```

- **join**：连接 open 后立即发。`playerId` 用于断线重连（本地存的设备 ID）。游戏进行中无法新加入，只能重连。
- **action**：只有轮到该玩家且未弃牌/未 all-in 才有效。`raise` 的 `amount` 是**加注额**（非总额）。
- **startHand**：任意人可发；至少 2 名在线且有筹码玩家。
- **nextRound**：本轮下注完成后才允许。
- **endHand**：仅在 `round === 'showdown'` 时有效，提交选中的获胜者。

### 2.2 服务端 → 客户端（`ServerMessage`）

```ts
type ServerMessage =
  | { type: 'state'; state: PublicGameState }
  | { type: 'error'; message: string }
  | { type: 'pong' };
```

- **state**：任何状态变化都广播给房间内所有人（带各自 `yourPlayerId`）。
- **error**：操作非法时发给当事人（前端应弹 toast）。

### 2.3 游戏状态（`PublicGameState`）—— 前端渲染的全部依据

```ts
interface PublicGameState {
  roomId: string;
  players: Player[];
  round: 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  pot: number;
  currentBet: number;        // 当前轮最高下注额
  dealerIndex: number;
  currentPlayerIndex: number;
  smallBlind: number;
  bigBlind: number;
  handNumber: number;
  lastAction: string;        // 人类可读的最近动作，直接显示在 log 区
  lastActor: string;
  communityCards: number;    // 0/3/4/5
  yourPlayerId?: string;     // 仅发给该连接
}

interface Player {
  id: string;
  name: string;
  chips: number;
  position: number;          // 相对庄位：0=Dealer,1=SB,2=BB,3=UTG...
  isFolded: boolean;
  isActive: boolean;
  isAllIn: boolean;
  currentBet: number;        // 当前轮下注
  totalBet: number;          // 本手总下注
  hasActedThisRound: boolean;
  isConnected: boolean;
}
```

### 2.4 默认值（`types.ts`）
- `DEFAULT_CHIPS = 1000`
- `DEFAULT_SMALL_BLIND = 10`
- `DEFAULT_BIG_BLIND = 20`
- 最多 12 名玩家（`lobby-count` 旧 UI 写的 `/10` 是显示 bug，协议上限是 12）。

---

## 3. 前端如何对应（旧 index.html → 新 React）

旧 `public/index.html` 里这些逻辑是**正确且与后端一一对应的**，搬迁时照搬语义即可：

| 旧函数（index.html） | 新位置 | 做什么 |
|---|---|---|
| `connectWS(roomId, name)` | `useGameSocket()` hook | 建 WS、open 时发 join、onmessage 存 state、onclose 3 秒重连 |
| `ws.onmessage` | hook 内 | `{state}` → setState；`{error}` → toast |
| `doAction(action, amount)` | 组件调用 hook | `ws.send({type:'action', action, amount})` |
| `startHand()` / `nextRound()` | 组件调用 | `ws.send({type:'startHand'})` 等 |
| `confirmWinners()` | 摊牌组件 | `ws.send({type:'endHand', winnerIds})` |
| `updateSettings()` | 大厅设置 | `ws.send({type:'updateSettings', settings})` |
| `isRoundComplete()` | 派生选择器 | 判断本轮是否结束 → 显示"下一轮"按钮 |
| `getDeviceId()` / `savePlayer()` | hook 内 localStorage | 断线重连身份持久化 |

### 本轮是否完成的判断（前端要复刻这个逻辑，决定操作栏显示）
```ts
function isRoundComplete(state: PublicGameState): boolean {
  const actionable = state.players.filter(p => !p.isFolded && p.isActive && !p.isAllIn);
  if (actionable.length === 0) return true;
  return actionable.every(p => p.hasActedThisRound && p.currentBet === state.currentBet);
}
```

### "是否轮到我"的判断
```ts
const myIdx = state.players.findIndex(p => p.id === state.yourPlayerId);
const isMyTurn = state.currentPlayerIndex === myIdx
  && me && !me.isFolded && !me.isAllIn
  && state.round !== 'showdown' && state.round !== 'waiting';
```

### 位置标签（D / SB / BB）前端自行推算
后端只给 `dealerIndex`。SB/BB 索引前端算（旧 UI 已有现成实现，照搬）：
```ts
const activeIndexes = players.map((p,i) => p.isActive ? i : -1).filter(i => i>=0);
const nextActive = (from) => { /* 在 activeIndexes 里找下一个 */ };
const sbIdx = activeIndexes.length === 2 ? dealerIndex : nextActive(dealerIndex);
const bbIdx = nextActive(sbIdx);
```

---

## 4. 连接生命周期注意点

1. **join 必须在 open 后发**，且带 `playerId`（localStorage 里 `pk_device_id`，没有就 `crypto.randomUUID()`）。
2. **重连**：`onclose` 时若 `state.round !== 'waiting'`（即游戏进行中），3 秒后自动重连，复用同一 `playerId`，后端会恢复该玩家身份。
3. 后端会在重连时**踢掉同 playerId 的旧连接**，前端不用处理冲突。
4. `beforeunload` 时 `ws.close()`。
5. 游戏进行中掉线：玩家被标记 `isFolded` 且轮到他时自动过到下一人；大厅阶段掉线：直接移除。
