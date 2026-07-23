# poker-scorer 架构与设计模式

> 配套：[README.md](../README.md) · [TECHNICAL.md](./TECHNICAL.md)  
> 本文接替已完成的 `RISKS_AND_IMPROVEMENTS` 任务卡体系，转向**模式驱动的演进**：如何在不大重构的前提下，让边界更清晰、耦合更低、改规则更安全。

---

## 1. 产品形态决定了模式选择

本项目是 **Cloudflare Workers + 每房一个 Durable Object + 零构建前端** 的实时计分器，不是通用扑克引擎。

| 约束 | 对架构的含义 |
|------|----------------|
| 单房串行（DO） | 不需要分布式锁；**命令串行执行**即可 |
| 状态 < 10KB | 全量同步可接受；不必上 OT/CRDT |
| 瘦客户端 | 判决在服务端；前端是 **Observer + Renderer** |
| Free Tier / 无账号 | Host 用 `deviceId` 轻量代理身份，非 OAuth |
| 线下熟人局 | 允许「人手选胜」；用预览降低误操作，而非自动牌力 |

因此优先选择 **小而可测的纯函数 + 清晰命令分发 + 显式状态机**，而不是企业级分层全家桶。

---

## 2. 已落地的模式（代码中可指认）

### 2.1 Command（命令）— WebSocket 消息

**原理**：把「意图」编码为不可变消息对象，由中心调度器执行；发送者不知道内部状态如何迁移。

**本项目**：

```
ClientMessage.type → GameRoom.webSocketMessage switch → handleX()
```

| 命令 | 副作用 |
|------|--------|
| `action` / `startHand` / `nextRound` | 改 `GameState` + broadcast |
| `previewEndHand` | **无**落盘副作用，只回 `preview` |
| `sync` / `ping` | 读路径；`sync` 仅回推请求者 |

**演进方向（未强制拆文件）**：把 `switch` 收成 `Record<type, Handler>`，便于加命令时不改巨型方法体。Handler 签名建议：

```ts
type Handler = (ctx: RoomContext, ws: WebSocket, msg: ClientMessage) => Promise<void>;
```

`RoomContext` 只暴露 `game`、`save`、`broadcast`、`sendError` 等端口，避免 Handler 直接摸 DO 私有字段（**依赖倒置**）。

### 2.2 State（状态）— 手牌轮次

**原理**：对象在不同状态下接受不同操作；转移表比散落 `if (round === …)` 更可审计。

**本项目状态**：

```
waiting → preflop → flop → turn → river → showdown → waiting
              ↘（shouldRunOutBoard）→ showdown
              ↘（独胜）→ waiting
```

守卫示例：

- `handleAction`：禁止 `waiting` / `showdown`
- `handleSettings` / `rebuy` / `removePlayer`：仅 `waiting`
- `handleEndHand`：仅 `showdown` + host

**演进**：抽 `canTransition(from, event)` 纯表，测试只断言转移表，不启 DO。

### 2.3 Specification（规格 / 谓词）— 玩家规则

**原理**：把业务规则做成可组合的布尔谓词，避免「可行动 / 争夺底池」在多处复制后漂移。

**已落地**：`src/player-rules.ts`

| 谓词 | 语义 |
|------|------|
| `isActionable` | 未弃牌 ∧ 本手参与 ∧ 未 all-in ∧ 未挂机 |
| `isContesting` | 未弃牌（**含**挂机，防断线独赢） |

`GameRoom.advanceTurn` / `isRoundComplete` / `setFirstToAct` 已改用 `isActionable`。  
前端 `isMyTurn` 仍手写四字段——**下一刀应 import 同源模块或生成共享文档契约**（Workers 前端无 TS 共享包时，至少在 TECHNICAL §9 锁死）。

### 2.4 Strategy（策略）— 结算规划

**原理**：算法可替换、与副作用分离；同一策略服务「预览」与「落盘」。

**已落地**：`planPotsByTiers` / `buildSettlementPayouts` 在 `pot-settlement.ts`（纯函数）。  
`awardPotsByTiers` 只负责 apply chips + `lastWinnerIds`（跳过 `refund`）。

这是项目里最干净的 **策略 + 两阶段提交** 示例：先 plan 全成功，再动筹码。

### 2.5 Observer（观察者）— 前端事件总线

**原理**：主题持有订阅列表，状态变化时通知；发布者不依赖具体 UI。

**已落地**：

- `socket.onConn` / `onMessage` → `app.js` 路由
- `app` → `render` / `feedback` / `toast`
- 操作栏 **事件委托**（单一 click 监听 + `data-action`），避免每次 state 重绑闭包

### 2.6 Facade（外观）— `app.js`

**原理**：对外暴露「创建房间 / 加入 / 离开」等用例，对内编排 socket、storage、modal。

保持 `app.js` 薄：新功能优先落在 `actions` / `render` / `socket`，不要把规则写进 facade。

### 2.7 Memento / Snapshot — DO storage

**原理**：把内部状态序列化为可恢复快照。

`save()` / `load` 的 `game` 记录即 Memento。Hibernation 下 attachment `{ playerId, deviceId }` 是连接级 memento。

### 2.8 Identity Map + CAS — 房间目录

`RoomRegistry.claim` 是 **compare-and-set 占位**；`playerDevices` 是 device→player 的身份映射，支撑重连与 host。

### 2.9 Policy（策略对象 / 授权）— Host

```
hostDeviceId = 首个带 deviceId 的 join
敏感命令：endHand / updateSettings / removePlayer / rebuy(他人)
开放命令：action / startHand / nextRound / previewEndHand
```

`requireHost(ws, label)` 是 **Policy check** 的最小实现。未绑定 host 的旧房默认放行，避免升级锁死。

### 2.10 Soft vs Hard lifecycle

| 触发 | 模式 |
|------|------|
| 北京 04:00 + waiting | **Soft reset**：清牌局进度，保留座位/筹码/host/口令 |
| 7 天 TTL | **Hard destroy**：关 WS、registry、deleteAll |

这是 **Template Method** 骨架：`alarm` 决定 soft/hard，具体步骤各私有方法。

---

## 3. 推荐的下一步重构（按收益 / 风险排序）

> 原则：每次只动一条边界；谓词与结算优先纯函数 + 测试钉死。

### P0 — 感知与解耦（不改规则）

| 项 | 模式 | 说明 |
|----|------|------|
| `showView` 同页不重播动画 | 状态幂等 | 已在目标 view 则 return |
| `renderActionBar` 签名跳过 | Memo / 脏检查 | 避免弃牌武装态被 state 冲掉 |
| 异步 busy | Command 进行中标志 | 创建/加入/预览防连点 |

### P1 — 后端边界

| 项 | 模式 | 说明 |
|----|------|------|
| Handler 注册表 | Command | 从 `switch` 迁出，单测可 mock ctx |
| Round 转移表 | State | `nextRound` / auto-showdown 表格化 |
| 前端 `isMyTurn` 对齐 `isActionable` | Specification 同源 | 复制规则到 `render.js` 顶部注释 + 单测文档 |

### P2 — 前端结构

| 项 | 模式 | 说明 |
|----|------|------|
| 列表 patch 而非全量 innerHTML | Virtual DOM 思想的轻量版 | 只改 chips / is-turn class |
| `esc` 改字符串表 | 纯函数 | 去掉每次 createElement |
| Toast / Modal 统一 | Presenter | 一个 `notify({ kind, text })` |

### 明确不做

- React / monorepo / 完整 CQRS 总线  
- 自动算牌力  
- 断线改 fold、单挑 postflop 改 SB 先动  
- 为共享 3 个谓词上构建链  

---

## 4. 分层与依赖方向（目标图）

```
                    ┌─────────────┐
                    │  public/*   │  Observer / Facade / Renderer
                    │  (ESM UI)   │
                    └──────┬──────┘
                           │ WebSocket 命令
                           ▼
┌──────────────┐    ┌──────────────┐    ┌─────────────────┐
│ room-registry│◄───│   index.ts   │───►│    GameRoom     │
│  (CAS 目录)  │    │  路由 Facade │    │ Command 调度器   │
└──────────────┘    └──────────────┘    └────────┬────────┘
                                                 │
                    ┌────────────────────────────┼────────────────────┐
                    ▼                            ▼                    ▼
            player-rules.ts              pot-settlement.ts         types.ts
            (Specification)              (Strategy 纯函数)         (契约)
```

**规则**：箭头只能向下指到纯模块；`pot-settlement` / `player-rules` **不得** import `game-room`。

---

## 5. 不变量仍高于模式

模式是组织代码的方式；下列不变量改错即产品事故（详见 TECHNICAL §7）：

1. 单挑翻牌后 **BB** 先动  
2. 断线 = sitting-out ≠ fold；争夺底池看 `!isFolded`  
3. 不足额 all-in 不完整重开、不提升 `lastRaiseSize`  
4. 结算两阶段：plan 失败则零副作用  
5. `refund` 层不进 `lastWinnerIds`  

任何「优雅重构」若动到上述路径，必须带齐对应 vitest。

---

## 6. 当前产品能力快照（原任务卡已全部落地）

| 能力 | 状态 |
|------|------|
| 信任文案 / 确认链 / 结算预览 | 已有 |
| `roundComplete` SSOT | 已有 |
| plan + preview + refund 语义 | 已有 |
| CI / deploy checklist / serverVersion | 已有 |
| 两人桌摊牌简化 | 已有 |
| **日切 soft reset（保留筹码）** | 已有 |
| **轻量 host（deviceId）** | 已有 |
| **标准 minRaise / lastRaiseSize** | 已有 |
| **可选入桌口令** | 已有 |

历史 issue 任务卡文档已删除；后续演进以 **本文 + TECHNICAL** 为准。

---

## 7. 修改时怎么选模式（决策清单）

1. **是规则谓词吗？** → 放纯函数（Specification），两边共用语义。  
2. **是可替换算法吗？** → Strategy 纯模块 + 单测。  
3. **是用户意图吗？** → ClientMessage 命令 + 单一入口校验。  
4. **是轮次相关吗？** → 先画状态转移，再写 handler。  
5. **是权限吗？** → Policy（`requireHost`），不要散落 `if`。  
6. **是 UI 反应吗？** → Observer 订阅，禁止在 socket 里写 DOM。  
7. **不确定？** → 不抽模式，先写测试再抽。

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-23 | 初版：接替 RISKS 任务卡；记录已落地模式与演进清单；T17–T22 产品决策落地 |
