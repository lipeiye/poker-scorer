# 风险评估、瘦身与改进建议

> 文档性质：工程复盘与路线图（非 API 规格）  
> 配套： [README.md](../README.md) · [TECHNICAL.md](./TECHNICAL.md)  
> 评估基准：当前仓库代码（Cloudflare Workers + GameRoom DO + 零构建前端）  
> 产品定位：熟人线下德州扑克**计分器**，非公开对战平台、非自动判牌引擎  

本文回答三件事：

1. **有哪些风险**——出了什么问题、为什么是问题、在什么场景会爆  
2. **哪里可以瘦身**——减什么、别减什么、原因  
3. **可以做什么改进**——建议动作、预期收益、优先级与改动面  

阅读对象：项目维护者、未来改规则的自己或 Agent。改核心逻辑前请先读 [TECHNICAL.md §7 扑克规则不变量](./TECHNICAL.md#7-扑克规则不变量)。

---

## 目录

1. [总体判断](#1-总体判断)
2. [风险清单（按优先级）](#2-风险清单按优先级)
3. [可瘦身空间](#3-可瘦身空间)
4. [改进建议与技术路径](#4-改进建议与技术路径)
5. [不建议做的事](#5-不建议做的事)
6. [推荐路线图](#6-推荐路线图)
7. [附录：与代码落点的对照](#7-附录与代码落点的对照)

---

## 1. 总体判断

| 维度 | 判断 |
|------|------|
| 是否「能用」 | 是。线下 2～12 人记分、断线挂机、主池/边池分档结算已闭环 |
| 最大风险类型 | **信任模型误操作** + **维护时规则分叉**，不是吞吐或内存 |
| 架构是否过度 | 否。Workers + 每房一 DO + 全量 WebSocket state 对规模匹配 |
| 是否需要大重构 | 否。优先小改：确认、预览、后端下发完成标志、补测 |
| 瘦身方向 | 删噪音依赖/冗余字段、减可选 UI 重量；**勿砍**断线坐出与边池核心 |

**一句话**：熟人局场景下没有「必须立刻修否则线上会炸」的硬伤；真正要防的是「点错结算把钱分错」和「半年后改谓词只改一端导致 UI 与后端分叉」。

---

## 2. 风险清单（按优先级）

优先级含义：

- **P0**：数据错误或体验灾难，且容易发生  
- **P1**：设计取舍带来的结构性风险，场景命中时疼  
- **P2**：运维/维护类，低频但排查成本高  
- **P3**：安全与规模边界，当前定位下可接受  

---

### 2.1 P1 — 无权限 / 全桌信任模型

#### 现象

任何已入座、能发 WebSocket 消息的连接都可以：

- `startHand` / `nextRound` / `endHand`  
- `updateSettings`（改盲注）  
- `rebuy`（给**任意** `targetPlayerId` 补码）  
- `removePlayer`（移除离线玩家）  

服务端**不校验**「是否房主」「是否本人」「是否多数同意」。

#### 为什么是问题

1. **误触成本高**：结算、改盲注直接影响筹码账本；线下吵起来难追溯。  
2. **恶意零门槛**：只要知道房间码即可入座捣乱（见 2.6）。  
3. **产品叙事与实现一致**：文档写了「无房主」，但用户直觉常默认「创建者才是桌主」。

#### 为何当前仍可接受

- 目标场景是**物理同桌熟人**，房间码口头/微信传递，攻击面小。  
- 引入完整权限（角色、邀请、密码）会显著增加协议与 UI，偏离「打开即用」。

#### 可做的事与原因

| 动作 | 原因 |
|------|------|
| 敏感操作二次确认（结算、改盲注、移除、给他人补码） | 不改信任模型，只降误触率；实现全在前端 + 可选服务端幂等提示 |
| 轻量 host：建房时的第一个 `deviceId` 记为 host，敏感写操作仅 host | 改动面可控（`GameState.hostDeviceId` + 若干 guard），覆盖 80%「别乱点」诉求 |
| 文档与 UI 明示「任何人可操作」 | 降低预期落差，零代码成本 |

**不优先**：完整账号体系、投票踢人、操作审计日志落库——对 Free Tier 熟人局过重。

#### 代码落点

- 无授权检查：`src/game-room.ts` 各 `handle*`  
- 前端移除已有 `confirm`：`public/scripts/app.js`（仅 `removePlayer`）

---

### 2.2 P1 — 胜负完全依赖人手选择

#### 现象

应用**不算牌力**。摊牌时客户端提交 `tiers`（名次分档）或兼容字段 `winnerIds`；服务端 `awardPotsByTiers` 只做：

- id 存在、`!isFolded`、不跨档重复  
- 按 `totalBet` 分层做主池/边池与退还  
- 未覆盖的多人层 → **拒绝整次结算**（防半结算）

「谁牌大」完全由人手点选。

#### 为什么是问题

1. **排错档 ≠ 协议错误**：服务端会诚实按错误排名分钱，账本「数学正确、业务错误」。  
2. 边池场景认知负担高：用户可能只选主池赢家，忽略边池需「下一档」。虽有拒绝机制，仍依赖理解文案。  
3. 与「积分器」定位一致，但线下酒后/嘈杂环境误点概率上升。

#### 为何当前仍可接受

- 物理牌桌本身就由人喊赢家；应用只是记账。  
- 自动判牌力需要手牌输入，产品边界会变成完整扑克客户端。

#### 可做的事与原因

| 动作 | 原因 |
|------|------|
| **结算预览**：选完 tiers 后展示「主池 X → A；边池 Y → B」再确认 | 把「数学结果」提前暴露，误操作在提交前可发现 |
| 预览算法可与 `awardPotsByTiers` 共用纯函数（抽到 `src/` 或前后端各一份严格测试） | 避免预览与实结算分叉——这是新的同源风险，必须用同一实现或共享模块 |
| 2 人桌默认「点一人即确认」；≥3 人或存在 all-in 再显示分档 UI | 降 80% 对局的认知负担 |
| 结算成功后大厅明确展示 `sidePots` / `lastAction` 明细 | 已有字段，加强渲染即可，便于当场对账 |

#### 代码落点

- `handleEndHand` / `awardPotsByTiers`：`src/game-room.ts`  
- 分档 UI：`public/scripts/render.js`（`selectedTiers` / `renderShowdown`）  
- 发送：`public/scripts/actions.js` `confirmTiers`

---

### 2.3 P1 — 规则相对标准 NLHE 的简化偏差

#### 现象（有意简化）

| 项 | 当前行为 | 标准 NLHE 常见期望 |
|----|----------|-------------------|
| 最小加注 | 增量 ≥ `bigBlind`（开池与加注同一标准） | 常为「上次加注/加注额」 |
| Straddle | 无 | 部分局有 |
| 盲注短码 | `currentBet = max(sbAmt, bbAmt)` | 细节因规则书略有差异 |
| 不足额 all-in | 不完整重开（不 `resetActedFlags`） | 与多数线上一致，已处理 |

#### 为什么是问题

- 打过正规线上的朋友会感觉「加注尺寸不对」。  
- 文档若写不清，会被当成 bug 反复「修复」。

#### 为何当前仍可接受

- 熟人记分局极少严格执行「最小加注 = 上次加注额」。  
- 实现 `lastRaiseSize` 会牵动 `handleAction`、前端 raise 控件与一批测试，收益有限。

#### 可做的事与原因

| 动作 | 原因 |
|------|------|
| README / 本文件持续写明简化项 | 防误修；零运行时成本 |
| 若未来要上标准加注：在 `GameState` 增 `lastRaiseSize`，raise 成功时更新，开新街清零 | 路径清晰，单独 PR，勿与边池改动搅在一起 |
| 不实现 straddle，除非明确需求 | 位次与首动逻辑会再长一截 |

---

### 2.4 P1 — 每日清理与 TTL 毁房

#### 现象

- Alarm 取「下一北京 04:00」与 `expiresAt`（创建 +7 天）的较早者。  
- **`round !== waiting`**：不销毁，延后 15 分钟再查。  
- **waiting 下的每日清理或 TTL 到期**：关 WS、`RoomRegistry.remove`、`storage.deleteAll`。  

注意：这是**整房销毁**，不是「只重置筹码、保留玩家列表」。

#### 为什么是问题

1. 跨夜续摊：凌晨 4 点后人若停在大厅，房间可能消失，需重建、重分享房号。  
2. 与用户心智「这个房码就是今晚的桌子」不完全一致。  
3. 历史版本曾有「重置清空玩家」的 `checkDailyReset`；现已改为 alarm 销毁。文档必须与代码一致，否则误判行为。

#### 为何当前仍可接受

- Free Tier 需要垃圾回收，防止废弃 DO 无限堆积。  
- 手牌中推迟，避免「 bulk 局被杀掉」。  
- 04:00 避开国内熟人局黄金时段。

#### 可做的事与原因

| 动作 | 原因 |
|------|------|
| UI 显示「房间将于本地时间 ×× 清理 / 过期」 | 预期管理，改动小（需下发 `expiresAt` 或下次 cleanup 时间） |
| 策略改为「每日只重置筹码与 handNumber，保留 players 与 roomId」 | 固定牌友长期同码更舒服；实现上 alarm 分支分「soft reset」与「hard delete(TTL)」 |
| 保持硬删除但把时间改为可配置 | 灵活，但增加运维面 |

**技术注意**：soft reset 时要关闭「进行中」守卫逻辑不变；重置后 `broadcast` 全员回 lobby；`playerDevices` 是否保留需明确（建议保留以便重连）。

#### 代码落点

- `nextCleanupMs` / `nextCleanupOrExpiry` / `alarm`：`src/game-room.ts`  
- TTL 常量：`ROOM_TTL_MS` in `src/types.ts`

---

### 2.5 P1 — 前后端同源逻辑分叉（维护风险）

#### 现象

下列逻辑在后端与前端**各有一份**：

| 逻辑 | 后端 | 前端 |
|------|------|------|
| 本轮是否结束 | `isRoundComplete()` | `render.js` 同名 |
| 是否轮到我 / 可行动 | `advanceTurn` / `setFirstToAct` 谓词 | `isMyTurn`、卡片 `isTurn` |
| toCall | `handleAction` | `renderActionBar` |
| D/SB/BB 展示 | 位次环 | `renderGame` 本地推算 |

历史上曾出现前端少 `isActive` / `isSittingOut` 导致通知误触发等问题。

#### 为什么是问题

1. 改后端谓词时若漏前端 → **UI 与真实行动权不一致**（看起来能点 / 不能点）。  
2. Agent 或人「只改一处」的概率高。  
3. 没有编译期约束（前端是 JS，不共享 TS 模块）。

#### 为何当前仍可接受

- 状态很小，全量推送；谓词副本不长。  
- 仔细对照 + 测试可压住。  
- 当前前端谓词已与后端四字段对齐（相对早期审计有改善）。

#### 可做的事与原因

| 动作 | 原因 |
|------|------|
| **后端下发 `roundComplete: boolean`**（及可选 `actionablePlayerIds`） | 前端「下一轮」按钮只信标志，删除 `isRoundComplete` 副本 |
| 保留 `isMyTurn` 但严格等于 `currentPlayerIndex === me && 四字段` | `currentPlayerIndex` 已是 SSOT，前端只做展示过滤 |
| 改谓词 PR 模板强制 checklist | 流程手段，零架构成本 |
| 单测锁死单挑 flop BB 先动等 | 防止「修 bug」回退（见历史血泪） |

**不推荐**：上 monorepo 共享包仅为几个谓词——对当前仓库过重。

#### 代码落点

- 后端：`game-room.ts` `isRoundComplete` / `advanceTurn` / `setFirstToAct`  
- 前端：`public/scripts/render.js`  
- 文档：TECHNICAL §9

---

### 2.6 P3 — 安全面（公开部署时升为 P1）

#### 现象

- 无登录、无 CSRF、CORS `Access-Control-Allow-Origin: *`（DO fetch 路径）。  
- 房号 6 位，字符集 32 → 约 \(32^6 \approx 1.07 \times 10^9\) 空间；不可枚举殆尽，但**活跃房可被撞库式尝试**（配合 `/exists`）。  
- 知房号即可 join（waiting）或干扰。

#### 为什么是问题

- 若把 Worker URL 发到公开论坛，可能有陌生人进房。  
- 无速率限制时，`POST /api/rooms` 可被刷（Free Tier 配额消耗）。

#### 为何当前仍可接受

- 产品默认「链接/房号只给朋友」。  
- 不做开放匹配大厅。

#### 可做的事与原因

| 动作 | 原因 |
|------|------|
| 建房可选「入桌口令」（join 时校验） | 轻量提升，不引入账号 |
| Cloudflare 侧基础 Bot / 速率限制 | 平台能力，不进业务代码 |
| 文档写明「勿公开分享到可被爬的地方」 | 预期管理 |

---

### 2.7 P2 — 部署与缓存一致性

#### 现象

- 后端：**必须** `wrangler deploy`，无热更新。  
- DO 状态跨版本保留：进行中手牌可能继续用旧内存语义直到下一手/下一轮走新代码路径。  
- 前端：`?v=9` + SW `pk-shell-v10`；漏 bump 时 PWA 用户长期旧壳。

#### 为什么是问题

- 「我 deploy 了怎么还是旧行为」排查成本高。  
- 半局新旧逻辑混用虽少见，但在改 `awardPotsByTiers` 等时危险。

#### 可做的事与原因

| 动作 | 原因 |
|------|------|
| Deploy checklist：后端 Version ID + 前端 cache bump | 纪律 |
| `PublicGameState` 带 `serverVersion` 或 build 时间，UI 可提示「请强刷」 | 可观测 |
| 大改结算逻辑时建议等待局间或短暂维护 | 运维策略 |

#### 代码落点

- `public/index.html` script/css query  
- `public/sw.js` `CACHE` 常量  
- `wrangler deploy`

---

### 2.8 P2 — 测试与 CI 缺口

#### 现象

- 有较完整的 `test/game-room.test.ts`（边池、断线坐出、alarm 等）。  
- 无 GitHub Actions 等 CI 默认门禁。  
- Cloudflare vitest pool 在部分环境慢/超时。  
- 个别不变量（如**单挑翻牌后 BB 先动**）历史上被误改，应用例钉死。

#### 为什么是问题

- 回归依赖人工 `npm test`；Agent/人容易漏跑。  
- 沙箱超时会诱发「测不过就跳过」的坏习惯。

#### 可做的事与原因

| 动作 | 原因 |
|------|------|
| CI：`typecheck` + `vitest` on push | 低成本安全网 |
| 补测：单挑 flop 首动、不足额 all-in 不重开、挂机不独赢 | 锁血泪规则 |
| 纯 Node 镜像关键函数的脚本（不依赖 workers pool） | 本地/CI 快速反馈（TECHNICAL 已提示） |

---

### 2.9 P2 — 独胜 / 边池 / 短码等边缘（多数已修，余波）

下列在 2026-07 审计与修复后**现状较好**，仍记一笔防回退：

| 主题 | 现状 | 残留注意 |
|------|------|----------|
| 断线=坐出≠弃牌 | `isSittingOut`，争夺 `!isFolded` | 禁止改回 fold |
| 边池守恒 | `awardPotsByTiers` 退还/拒绝 | 预览须共用逻辑 |
| 全体 all-in 自动摊牌 | `shouldRunOutBoard` | 仍需人手选胜 |
| 独胜进 waiting | `awardToSoloSurvivor` | — |
| raise 最低 bigBlind | 无条件检查 | 前端 min 运行时设置 |
| BB 短码 currentBet | `max(sbAmt,bbAmt)` | 与「名义大盲」不同，属有意 |

**风险性质**：不是「未修 bug」，而是**再修改时的回退风险**。用测试 + TECHNICAL 不变量章节防护。

---

### 2.10 P3 — 产品体验边角

| 项 | 说明 |
|----|------|
| 无观战模式 | 旁观者须入座占位或看别人屏幕 |
| 离线时长展示不挂定时器 | 依赖下次 state 推送刷新，可接受 |
| 音效移除 | 防系统抢耳机，依赖标题/震动/横幅 |
| `sendToAll` 用 `error` 类型 | 部分业务提示走 error 通道，前端一律 toast，语义略混 |

可做：区分 `type: 'notice'`；观战非必须。

---

## 3. 可瘦身空间

### 3.1 值得瘦的

| 目标 | 做法 | 原因 | 风险 |
|------|------|------|------|
| 未使用的 npm 依赖 | 确认 `hono` 是否仍被 import；未用则移出 `package.json` | 当前路由为手写 `fetch`，依赖可能是历史残留 | 极低 |
| 冗余状态字段 | 评估删除 `lastActor`（与 `lastAction` 重叠） | 减协议噪音；前端未强依赖 | 需同步 types + publicState + 测试 |
| 图片体积 | 压缩 hero / 庆祝图，或换更小资源 | `public/assets` ~156KB，移动网络可感 | 观感 |
| 边池 UI 默认路径 | 2 人无 all-in 侧简化交互 | 降复杂度感知，不是删后端边池 | 需分支 UI |
| 历史文档 | 已收敛为 README + TECHNICAL + 本文 | 减少过时文档误导 | — |

### 3.2 看起来能瘦、但不建议瘦的

| 目标 | 为什么别砍 |
|------|------------|
| 断线坐出整套语义 | 线下「去拿可乐被弃牌」是核心差评点；已付出血泪修复成本 |
| `awardPotsByTiers` | 多路 all-in 无边池会直接分错钱 |
| `shouldRunOutBoard` / auto showdown | 否则全员 all-in 要手动点多轮「下一轮」 |
| `RoomRegistry` 独立 DO | 可合并，但迁移与兼容成本 > 收益 |
| WebSocket 心跳与 `sync` | 移动端切后台是真实场景 |
| Hibernation + attachment | Free Tier 成本与连接恢复基础 |

### 3.3 结构是否该「上框架瘦前端」

**不建议**为了「现代化」上 React/Vue：

- 当前 7 个 ES module + 单 HTML 已清晰。  
- 构建链会带来缓存、部署、SW 复杂度。  
- 性能瓶颈不在 DOM。  

若未来要做复杂动画/多页，再评估，而不是现在。

---

## 4. 改进建议与技术路径

### 4.1 高价值 · 低～中成本

#### A. 结算预览 + 二次确认

**做什么**

1. 将 `awardPotsByTiers` 的「规划阶段」抽成纯函数：`planPots(players, pot, tiers) → { ok, plans } | { ok:false, message }`。  
2. 新增消息 `previewEndHand` 或复用只读 RPC：返回计划不改筹码。  
3. 前端确认页展示明细 → 用户点确认再 `endHand`。  

**为什么做**

- 直接降低 P1「分错钱」。  
- 复用规划逻辑可顺带单测纯函数，不依赖 DO 池。  

**注意**

- 预览与提交之间状态可能变（极少见）；提交时仍完整校验。  

#### B. 后端下发 `roundComplete`

**做什么**

```ts
// PublicGameState 增：
roundComplete?: boolean;
```

在每次 `broadcast` 前计算 `isRoundComplete()` 写入。前端「下一轮」按钮：

```js
if (state.roundComplete) { /* 显示下一轮 */ }
```

删除或降级 `render.js` 的 `isRoundComplete` 副本。

**为什么做**

- 消除最危险的一份同源逻辑。  
- 后端仍是行动权 SSOT。  

#### C. 敏感操作确认与文案

**做什么**

- `confirmTiers` 前强制预览步骤（与 A 合并）。  
- 改盲注、给他人 rebuy：`confirm()` 或应用内 modal。  
- 大厅文案：「本桌任何人可开始/结算/改盲注」。  

**为什么做**

- 不引入 host 也能吃掉大部分误触。  

#### D. 不变量测试钉死

**做什么**（示例用例名）

1. 单挑：flop 后 `currentPlayerIndex` 为 BB。  
2. 不足额 all-in：已行动者 `hasActedThisRound` 不被错误清空到可重开加注。  
3. 一人断线坐出、另一人未 fold：不 `awardToSoloSurvivor`。  
4. `awardPotsByTiers`：短码只吃主池、超额退还、未排满拒绝。  

**为什么做**

- 回归成本最低的保险。  

#### E. Deploy / Cache 纪律

**做什么**

- README 或本文件固定 checklist。  
- 可选：`npm run deploy` 脚本 echo 提醒 bump SW。  

---

### 4.2 中价值 · 中成本

#### F. 轻量 Host

- `GameState.hostPlayerId` 或 `hostDeviceId`，join 创建者写入。  
- Guard：`endHand` / `updateSettings` / `removePlayer` / 他人 `rebuy`。  
- `startHand` 可仍开放（避免 host 上厕所卡桌）。  

#### G. 每日 soft reset

- Alarm 在 waiting：筹码回 `DEFAULT_CHIPS` 或清零策略二选一（需产品定）。  
- 保留 `roomId` 与 players。  
- TTL 7 天仍 hard delete。  

#### H. 标准最小加注增量

- `lastRaiseSize`，新街重置为 `bigBlind`。  
- 前端 raise min 跟后端一致下发 `minRaise`。  

---

### 4.3 低优先级

- `type: 'notice'` 与 `error` 分离  
- `serverVersion` 字段  
- join 口令  
- 观战  
- 自动牌力（基本等于换产品）  

---

## 5. 不建议做的事

| 事项 | 原因 |
|------|------|
| 把断线改回 fold | 已证伪的设计；破坏底池公平 |
| 「修正」单挑翻牌后为 SB 先动 | 违反标准 NLHE，历史回退过 |
| 为几个谓词上 React + monorepo | 成本 >> 收益 |
| 在 Free Tier 上做公开匹配大厅 | 安全与配额模型不匹配 |
| 无测试大改 `awardPotsByTiers` | 筹码守恒极脆 |
| 删除 RoomRegistry 只为「少一个 DO」 | 迁移坑大于收益 |

---

## 6. 推荐路线图

```
阶段 0（现状）
  熟人线下可用；文档已对齐代码

阶段 1 — 防误操作与防分叉（建议下一步）
  [ ] 结算预览 + 确认
  [ ] PublicGameState.roundComplete
  [ ] 敏感操作 confirm / 文案
  [ ] 补 3～5 条不变量测试
  [ ] （可选）CI typecheck + test

阶段 2 — 体验与运维
  [ ] 清理/过期时间展示
  [ ] soft reset vs 毁房 产品决策
  [ ] 轻量 host（若误触仍频发）
  [ ] 依赖清理（hono 等）与 lastActor 删除

阶段 3 — 规则深化（有明确需求再做）
  [ ] lastRaiseSize 标准加注
  [ ] 入桌口令 / 速率限制
```

**完成定义（阶段 1）**

- 分错钱路径必须多点一次确认且能看到金额预览。  
- 前端不再独立实现 `isRoundComplete`。  
- CI 或本地脚本能锁住单挑 postflop 首动与挂机不独赢。  

---

## 7. 附录：与代码落点的对照

| 主题 | 主要文件 |
|------|----------|
| 信任模型 / 无授权 | `src/game-room.ts` 各 handle* |
| 边池与结算 | `awardPotsByTiers`, `handleEndHand` |
| 断线坐出 | `markDisconnected`, `handleJoin`, `startHand` |
| 行动顺序 | `setFirstToAct`, `postBlinds`, `nextActiveIndex` |
| 自动摊牌 | `shouldRunOutBoard`, `autoAdvanceToShowdown` |
| 清理与 TTL | `alarm`, `nextCleanupMs`, `ROOM_TTL_MS` |
| 同源 UI | `public/scripts/render.js` |
| 连接恢复 | `public/scripts/socket.js`（heartbeat / sync / reconnect） |
| 路由与房号 | `src/index.ts`, `src/room-registry.ts` |
| 类型协议 | `src/types.ts` |
| 测试 | `test/game-room.test.ts` |

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-18 | 初版：基于全库阅读与产品定位的风险评估、瘦身与改进文档 |

---

*本文是判断与建议，不是缺陷必修清单。是否实施阶段 1 由维护者按实际牌局频率决定。*
