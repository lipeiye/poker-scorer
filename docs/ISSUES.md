# poker-scorer 问题与修复手册

> 2026-06-29 多 Agent 并行审计产物。覆盖 8 个维度，共发现 **5 个严重/高优先级问题**、**8 个中优先级问题**、**7 个低优先级问题**。
>
> **目标读者**：AI Agent、接手修复的工程师。每个问题含：现象 → 根因 → 定位(文件:行) → 修复方向 → 耦合风险。
>
> **前置阅读**：[TECHNICAL.md](./TECHNICAL.md)（架构与完整流程）。

---

## 目录

1. [严重 (Critical)](#1-严重-critical)
   - [C1. 每日凌晨4点重置摧毁进行中牌局](#c1-每日凌晨4点重置摧毁进行中牌局)
2. [高 (High)](#2-高-high)
   - [H1. Raise 最低限额在 currentBet=0 时被绕过](#h1-raise-最低限额在-currentbet0-时被绕过)
   - [H2. 全体 All-in 后需手动点击多次"下一轮"](#h2-全体-all-in-后需手动点击多次下一轮)
   - [H3. 缺少 Side Pot 机制导致多路 All-in 筹码分配错误](#h3-缺少-side-pot-机制导致多路-all-in-筹码分配错误)
   - [H4. handleEndHand 未校验 winner 是否已弃牌](#h4-handleendhand-未校验-winner-是否已弃牌)
3. [中 (Medium)](#3-中-medium)
   - [M1. awardPot 对不存在 winnerId 静默丢失筹码](#m1-awardpot-对不存在-winnerid-静默丢失筹码)
   - [M2. Solo-survivor 检测仅存在于 handleAction](#m2-solo-survivor-检测仅存在于-handleaction)
   - [M3. BB 短码时 currentBet 未锁定为 bigBlind](#m3-bb-短码时-currentbet-未锁定为-bigblind)
   - [M4. 前端 3 处缺少 isActive/isSittingOut 谓词](#m4-前端-3-处缺少-isactiveissittingout-谓词)
   - [M5. 前端 raise 输入 min="0" 可绕过最低限额](#m5-前端-raise-输入-min0-可绕过最低限额)
   - [M6. 缺少单挑翻牌后 BB 先动的直接测试](#m6-缺少单挑翻牌后-bb-先动的直接测试)
   - [M7. handleEndHand 静默失败（不发送错误消息）](#m7-handleendhand-静默失败不发送错误消息)
   - [M8. normalizeDealerIndex 死代码](#m8-normalizedealerindex-死代码)
4. [低 (Low)](#4-低-low)
   - [L1-L7 清理类问题](#l1-l7-清理类问题)
5. [耦合与约束地图](#5-耦合与约束地图)
   - [5.1 修改影响链](#51-修改影响链)
   - [5.2 前后端同源逻辑清单](#52-前后端同源逻辑清单)
   - [5.3 不可触碰的不变量](#53-不可触碰的不变量)
   - [5.4 测试覆盖缺口](#54-测试覆盖缺口)
6. [修复优先级路线图](#6-修复优先级路线图)

---

## 1. 严重 (Critical)

### C1. 每日凌晨4点重置摧毁进行中牌局

**现象**：如果牌局跨越北京时间凌晨 4:00，下一次 DO 被唤醒（任何 HTTP 请求或 WebSocket 连接）时，`checkDailyReset()` 会将 `players` 清空、`round` 重置为 `waiting`、`handNumber` 归零。进行中的一手牌、筹码分布、排行榜全部丢失。

**根因**：`checkDailyReset()` 无任何守卫，不检查当前是否有活跃牌局。

**定位**：

| 文件 | 行号 | 关键代码 |
|------|------|----------|
| `src/game-room.ts` | 84-115 | `checkDailyReset()` — 无条件替换整个 `this.game` |
| `src/game-room.ts` | 30-61 | `constructor` — `blockConcurrencyWhile` 中调用 `checkDailyReset` |
| `src/game-room.ts` | 63-82 | `loadOrCreate()` — 每次 `fetch()` 都调用 `checkDailyReset` |
| `src/game-room.ts` | 116-130 | `currentResetDate()` — 日期计算（北京时间 4am 边界） |

**当前逻辑**：
```typescript
// game-room.ts:84-115（简化）
private async checkDailyReset(): Promise<void> {
  const resetDate = this.currentResetDate();
  if (this.lastResetDate && resetDate > this.lastResetDate) {
    this.game = {
      // ... 全新 GameState，players: []，round: 'waiting'
    };
    // 存储 + broadcast
  }
}
```

**修复方向**：

方案 A（推荐）—— 推迟到 waiting 状态再重置：
```typescript
private pendingReset = false;

private async checkDailyReset(): Promise<void> {
  const resetDate = this.currentResetDate();
  if (this.lastResetDate && resetDate > this.lastResetDate) {
    this.lastResetDate = resetDate;
    if (this.game && this.game.round === 'waiting') {
      this.doReset();       // 空闲中 → 立即重置
    } else {
      this.pendingReset = true;  // 牌局中 → 标记延迟
    }
  }
}
// 在 handleEndHand 和 solo-survivor auto-award 之后检查 pendingReset
```

方案 B（更简单，但会丢每日重置的及时性）—— 仅在 `handleStartHand` 时才执行重置。

**耦合风险**：
- `checkDailyReset` 被 `constructor`（`blockConcurrencyWhile`）和 `loadOrCreate`（每次 `fetch`）两处调用
- 修改时需确保 DO 从 Hibernation 唤醒时也触发检查
- 重置会触发 `broadcast()` → 所有已连接客户端收到空 lobby 状态 → 需前端优雅处理

**⚠️ 额外注意**：即使修复了"牌局中不重置"的问题，当前重置逻辑也会清空**所有玩家**（而不只是筹码）。这意味着凌晨4点后所有人都必须重新加入房间。这对于固定牌友群可能是预期行为，但应在 UI 上明确提示"每日凌晨4点重置"。

**回归风险**：修改 `checkDailyReset` 的触发时机可能影响房间过期 alarm 的判断。务必保证 alarm 不受影响。

---

## 2. 高 (High)

### H1. Raise 最低限额在 currentBet=0 时被绕过

**现象**：翻牌后（flop/turn/river 首动，此时 `currentBet` 已被 `handleNextRound` 重置为 0），玩家可以 "加注" 任意低于 bigBlind 的金额（包括 1 筹码）。不符合标准德州规则——翻牌后的首注（opening bet）最低应为 bigBlind。

**根因**：minimum raise 检查有条件 `this.game.currentBet > 0`，翻牌后首动时短路。

**定位**：

| 文件 | 行号 | 关键代码 |
|------|------|----------|
| `src/game-room.ts` | 463 | `if (raiseAmount < this.game.bigBlind && this.game.currentBet > 0)` |

```typescript
// 当前（有问题）:
case 'raise': {
  const raiseAmount = amount || this.game.bigBlind;
  const totalNeeded = toCall + raiseAmount;
  // ...
  if (raiseAmount < this.game.bigBlind && this.game.currentBet > 0) {
    //        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //        当 currentBet === 0 时这个检查被短路！
    this.sendError(ws, `最小加注额为 ${this.game.bigBlind}`);
    return;
  }
}
```

**修复方向**：
```typescript
// 修复后:
if (raiseAmount < this.game.bigBlind) {
  // 无条件检查：开池下注（currentBet===0）和加注（currentBet>0）都至少需要 bigBlind
  this.sendError(ws, `最小加注额为 ${this.game.bigBlind}`);
  return;
}
```

**耦合风险**：
- 翻牌后首动场景：`handleNextRound` 第 543-547 行重置 `currentBet = 0`
- **前端同步**：`actions.js:28` 的 `adjustRaise()` 已 clamp 到 `bigBlind`，但 `index.html:122` 的 `<input min="0">` 可手动输入绕过 → 见 M5
- **注意**：如果未来实现"最小加注额 = 上一次加注的增量"（标准 NLHE 规则），需要额外记录 `lastRaiseIncrement`。当前实现用 `bigBlind` 作为固定增量下限，这是一个简化但可接受的偏离

**回归风险**：修改后需验证——翻牌后首动以等于 bigBlind 金额 raise 是否被接受（应该接受）。

**相关测试**：`test/game-room.test.ts` 第 293-318 行（all-in 边界测试），但没有专门测试 currentBet=0 时的 raise 最小限额。建议新增。

---

### H2. 全体 All-in 后需手动点击多次"下一轮"

**现象**：所有未弃牌玩家都 All-in 后，`isRoundComplete()` 正确返回 `true`，但牌局不会自动推进。玩家需手动点击 3 次"下一轮"（turn、river、showdown）、再点 1 次"选胜者并结束"。总计 4 次无意义的手动操作。

**根因**：`handleAction` 检测到 round complete 后只追加提示文字（第 495-497 行），不做自动推进。

**定位**：

| 文件 | 行号 | 关键代码 |
|------|------|----------|
| `src/game-room.ts` | 493-497 | `handleAction` 末尾：`if (isRoundComplete()) { lastAction += ' | 本轮下注完成...' }` |
| `src/game-room.ts` | 523-531 | `isRoundComplete()` — 排除 all-in 和 sitting-out 玩家 |
| `src/game-room.ts` | 534-562 | `handleNextRound()` — 需手动 WebSocket 消息触发 |

**修复方向**：在 `handleAction` 末尾，检测是否所有非弃牌玩家都已 All-in（`actionable.length === 0` 且存在 all-in 玩家），若是则自动推进到 showdown：

```typescript
// 在 handleAction 末尾，advanceTurn() 之后、isRoundComplete() 检查之前：
const actionable = this.game.players.filter(
  p => !p.isFolded && p.isActive && !p.isAllIn && !p.isSittingOut
);
const allInPlayers = this.game.players.filter(p => !p.isFolded && p.isAllIn);
if (actionable.length === 0 && allInPlayers.length > 0) {
  // 无人可行动但有人全下 → 自动推进到摊牌
  await this.autoAdvanceToShowdown();
  return;
}
```

`autoAdvanceToShowdown()` 需要：
1. 将 `round` 设为 `showdown`
2. 设置 `communityCards = 5`（模拟跳过 turn 和 river）
3. 设置 `lastAction` 表示"全体 All-in，直接摊牌"
4. 调用 `broadcast()`

**耦合风险**：
- 如果玩家希望在 All-in 后逐街看牌（实际牌桌上确实会逐张发公共牌），则不应跳过。但本应用是计分器（物理牌桌旁使用），不需要模拟发牌节奏
- `communityCards` 设为 5 意味着跳过了逐张翻牌的视觉体验。如果前端依赖 `communityCards` 的值做动画，需要确保前端能处理 0→5 的跳变。`render.js` 中社区牌用静态数字显示、无动画，因此安全
- **Do Not** 在自动推进时也自动调用 `awardPot`——仍需玩家手动选择胜者（除非只有 1 人未弃牌→见 M2）

**回归风险**：需验证正常有行动的牌局不会被误判为"全体 All-in"而提前结束。

---

### H3. 缺少 Side Pot 机制导致多路 All-in 筹码分配错误

**现象**：当多个玩家各有不同筹码量、且部分人 All-in 后其他人继续下注时，所有筹码混入单一 `game.pot`。如果在摊牌阶段将短码 All-in 玩家选为胜者，该玩家会赢得超出其 All-in 金额的筹码——这部分超额筹码来自其他玩家之间的相互下注，按标准规则应属于第二位胜者（side pot 逻辑）。

**根因**：整个游戏只有一个 `pot` 字段，`awardPot` 函数假设所有筹码对所有胜者等权。这是计分器定位的架构级简化——应用不追踪牌力、不自动判定胜者，由物理牌桌上的人选择胜者。但人可能选错（选了短码 All-in 者当主池胜者），从而产生错误的筹码分配。

**定位**：

| 文件 | 行号 | 关键代码 |
|------|------|----------|
| `src/game-room.ts` | 54 | `pot: number` — 单一底池字段 |
| `src/game-room.ts` | 738-758 | `awardPot()` — `Math.floor(pot / winnerIds.length)` 均分 |
| `src/game-room.ts` | 446-476 | `handleAction raise` — All-in 分支不创建 side pot |

**影响范围**：仅当同时满足以下条件时才触发：
1. ≥3 名玩家进入同一手牌
2. 至少 1 名玩家 All-in（筹码量 < 其他人的有效 stack）
3. All-in 后其他玩家继续下注
4. 摊牌时人手选错了胜者

**修复方向**：
- **短期（推荐）**：在 `TECHNICAL.md` 中明确文档化此局限，并在摊牌选胜者 UI 上提示"短码 All-in 玩家只能赢得主池"
- **长期**：实现主池+边池追踪。需要添加 `sidePots: Array<{amount: number, eligiblePlayerIds: string[]}>` 字段，在每次 All-in 时切出一个边池，`awardPot` 按 eligibility 分配

**耦合风险**：Side pot 改动是**破坏性的**——涉及 `GameState` 类型变更、`handleAction` 逻辑重写、`awardPot` 重写、前端 winner 选择 UI 改造（需显示每个胜者能赢的金额）、全部测试用例更新。建议在 Plan B（React 重写）时同步实现。

---

### H4. handleEndHand 未校验 winner 是否已弃牌

**现象**：摊牌阶段，客户端发送的 `winnerIds` 未经服务端验证。恶意或 buggy 客户端可将已弃牌玩家选为胜者，导致该玩家错误获得底池。

**根因**：`handleEndHand` 直接使用 `msg.winnerIds`，不验证对应玩家 `!isFolded`。

**定位**：

| 文件 | 行号 | 关键代码 |
|------|------|----------|
| `src/game-room.ts` | 723-736 | `handleEndHand()` — 只校验 `winnerIds.length === 0` 和 `round === 'showdown'` |
| `src/game-room.ts` | 738-758 | `awardPot()` — 不检查 `winner.isFolded` |

```typescript
// 当前 handleEndHand:
async handleEndHand(_ws, winnerIds) {
  if (this.game.round !== 'showdown') return;
  if (winnerIds.length === 0) { /* 报错 */ return; }
  this.awardPot(winnerIds);  // ← 无 winner 身份校验
}

// 当前 awardPot:
// 只检查 winner 在 players 中存在，不检查 isFolded
```

**修复方向**：
```typescript
// 在 handleEndHand 中，awardPot 调用前：
const validWinners = winnerIds.filter(id => {
  const p = this.game.players.find(p => p.id === id);
  return p && !p.isFolded;
});
if (validWinners.length === 0) {
  this.sendToAll('所选胜者无效');
  return;
}
this.awardPot(validWinners);
```

**耦合风险**：
- 前端 `render.js:205` 的候选胜者过滤是 `!p.isFolded && !p.isSittingOut`，在正常使用中不会出现弃牌玩家被选中的情况。但服务端校验作为安全网是必要的
- 修改后需同步更新 `test/game-room.test.ts` 中与 `handleEndHand` 相关的测试

---

## 3. 中 (Medium)

### M1. awardPot 对不存在 winnerId 静默丢失筹码

**定位**：`game-room.ts:748-754`

```typescript
const winner = this.game.players.find(p => p.id === winnerIds[i]);
if (winner) {
  winner.chips += amt;
  names.push(winner.name);
}
// winner 不存在时：静默跳过，但 pot 在 line 757 仍被清零
```

**触发场景**：winnerId 来自客户端（玩家在摊牌选择时恰好断线/离开）、或每日重置后旧 winnerId 残留。

**修复方向**：在 `awardPot` 开头校验所有 winnerId 对应的玩家存在。任一个不存在 → 报错 + 不执行分配 + 不清零 pot。

**耦合**：与 H4 的修复有重叠——建议统一在 `handleEndHand` 入口做 winner 校验，然后 `awardPot` 假设调用方已验证。

---

### M2. Solo-survivor 检测仅存在于 handleAction

**定位**：`game-room.ts:484-491`

```typescript
// 仅在 handleAction 中：
const activePlayers = this.game.players.filter(p => !p.isFolded);
if (activePlayers.length === 1) {
  this.game.round = 'showdown';
  this.awardPot([activePlayers[0].id]);
}
```

**缺口**：如果最后一人通过 `markDisconnected`（非 fold）变为唯一未弃牌者，走的是 `webSocketClose → markDisconnected → advanceTurn`，不会触发 solo-survivor 检测。牌局会继续在 preflop 等待，唯一的在线玩家无法结束手牌。

**修复方向**：将 solo-survivor 检测抽取为独立方法，在 `markDisconnected`（非 waiting 状态下）和 `handleAction` 两处都调用：

```typescript
private checkSoloSurvivor(): boolean {
  const contesting = this.game.players.filter(p => !p.isFolded);
  if (contesting.length === 1) {
    this.game.round = 'showdown';
    this.awardPot([contesting[0].id]);
    this.game.lastAction = `${contesting[0].name} 获胜（其余玩家弃牌/断线）`;
    this.broadcast();
    return true;
  }
  return false;
}
```

**耦合**：
- 需注意与 §6.2 断线坐出不变量的一致性：sitting-out 玩家 `!isFolded`，他们算 contesting → 正确
- 修复后也解决了"断线到只剩一人时牌局无法结束"的 UX 问题

---

### M3. BB 短码时 currentBet 未锁定为 bigBlind

**定位**：`game-room.ts:644`

```typescript
const bbAmt = Math.min(this.game.bigBlind, bb.chips);
// ...
this.game.currentBet = bbAmt;  // ← 如果 BB 只有 5 筹码，currentBet = 5
```

**影响**：`bigBlind=20`，BB 只有 5 筹码 → `currentBet=5`。后续 SB（post 了 10）的 `toCall = 5 - 10 = -5`，可以用 check（虽然 SB 实际上不够 BB）。严格规则中 `currentBet` 应保持 `bigBlind`（20），即使 BB 本人付不起全额。

**修复方向**：
```typescript
this.game.currentBet = this.game.bigBlind;
// currentBet 代表"本手牌的基准下注单位"，不应因 BB 个人筹码不足而下调
```

**耦合风险**：此修改会影响 `toCall` 计算——原本 SB 只需补到 5，修改后需补到 20。但实际筹码扣减仍以 `Math.min` 为准，所以 BB 不会多付。涉及的场景极其罕见（只有 BB 刚好吃完盲注后筹码 < bigBlind 且有人 raise 过才会触发），影响小但逻辑更正确。

---

### M4. 前端 3 处缺少 isActive/isSittingOut 谓词

**现象**：后端 `advanceTurn/setFirstToAct/isRoundComplete` 三处使用完整谓词 `!isFolded && isActive && !isAllIn && !isSittingOut`，但前端有 3 处少了字段。

**定位**：

| 位置 | 行号 | 缺失字段 | 风险 |
|------|------|----------|------|
| `render.js` `isMyTurn` | 177 | `isActive` | 低—后端不会把 currentPlayerIndex 指向此玩家 |
| `render.js` `isTurn` (CSS) | 118 | `isActive` | 低—仅影响视觉样式 |
| `app.js` `notifyMyTurnIfNeeded()` | 125-126 | `isActive` **且** `isSittingOut` | **中**—通知（标题闪动+震动+声音）会被错误触发 |

**修复方向**：三处都补全为与后端同源的完整 4 字段谓词。

**具体修复**：

`render.js:177`（isMyTurn）：
```javascript
// 修改前：
const isMyTurn = state.currentPlayerIndex === myIdx && me && !me.isFolded
  && !me.isAllIn && !me.isSittingOut && state.round !== 'showdown' && state.round !== 'waiting';
// 修改后：补上 me.isActive
const isMyTurn = state.currentPlayerIndex === myIdx && me && !me.isFolded
  && me.isActive && !me.isAllIn && !me.isSittingOut
  && state.round !== 'showdown' && state.round !== 'waiting';
```

`render.js:118`（isTurn CSS）：
```javascript
// 修改前：
const isTurn = i === state.currentPlayerIndex && !p.isFolded && !p.isAllIn
  && !p.isSittingOut && state.round !== 'showdown' && state.round !== 'waiting';
// 修改后：补上 p.isActive
const isTurn = i === state.currentPlayerIndex && !p.isFolded && p.isActive
  && !p.isAllIn && !p.isSittingOut && state.round !== 'showdown' && state.round !== 'waiting';
```

`app.js:125-126`（notifyMyTurnIfNeeded）：
```javascript
// 修改前：
const isMyTurn = s.currentPlayerIndex === myIdx && me && !me.isFolded
  && !me.isAllIn && s.round !== 'showdown' && s.round !== 'waiting';
// 修改后：补上 me.isActive && !me.isSittingOut
const isMyTurn = s.currentPlayerIndex === myIdx && me && !me.isFolded
  && me.isActive && !me.isAllIn && !me.isSittingOut
  && s.round !== 'showdown' && s.round !== 'waiting';
```

**耦合**：这些谓词与后端 `game-room.ts:515, 524-525, 667` 同源。**改后端谓词时必须同步更新此处**——参见 §5.2 前后端同源逻辑清单。

---

### M5. 前端 raise 输入 min="0" 可绕过最低限额

**定位**：`public/index.html:122`

```html
<input type="number" id="raise-amount" min="0" step="10" value="20">
```

**问题**：`min="0"` 硬编码，未动态绑定到 `bigBlind`。用户可手动输入 1 并点击加注。`adjustRaise()`（`actions.js:28`）的 clamp 逻辑只在点 +/- 按钮时生效，`doRaise()`（`actions.js:32-35`）直接 `sendAction('raise', amount)` 不校验。

**修复方向**：在 `render.js` 的 `renderActionBar` 中动态设置 `min`：
```javascript
raiseInput.min = state.bigBlind;
```
并在 `doRaise()` 中加客户端校验：
```javascript
const minRaise = state.bigBlind;
if (amount < minRaise) {
  toast(`最低加注 ${minRaise} 筹码`);
  return;
}
```

**耦合**：此修复与 H1（后端 raise 限额修复）互补。即使 H1 修复后后端会拒绝，前端校验能提供即时反馈（避免 round-trip 延迟）。

---

### M6. 缺少单挑翻牌后 BB 先动的直接测试

**定位**：`test/game-room.test.ts`

**问题**：`setFirstToAct()` 单挑翻牌后逻辑（`game-room.ts:658`：`startIdx = nextActiveIndex(dealerIndex)`）没有直接的单元测试。现有测试只覆盖了单挑翻牌前（庄家先动）。

**历史背景**：TECHNICAL.md §6.1 明确指出"单挑翻牌后大盲先动是标准规则、不是 bug。曾被误当 bug 改成'永远小盲先动'又回退"。

**建议新增测试**：
```typescript
it('单挑翻牌后：大盲先动', async () => {
  // 2 人桌 → preflop 庄家先动 → 完成 preflop → nextRound 到 flop
  // → 断言 currentPlayerIndex 指向 BB（非 dealer）
  const room = await createRoom();
  const p1 = await joinPlayer(room, 'Alice');  // dealer
  const p2 = await joinPlayer(room, 'Bob');    // BB
  await startHand(room, p1);
  // preflop: p1 (dealer=SB) acts first
  expect((await room.getState()).currentPlayerIndex).toBe(/* p1 index */);
  // complete preflop...
  // flop: p2 (BB) should act first
  expect((await room.getState()).currentPlayerIndex).toBe(/* p2 index */);
});
```

**耦合**：该测试的断言依赖于对 `setFirstToAct()` 的正确理解。参见 §5.3 行动顺序不变量。

---

### M7. handleEndHand 静默失败（不发送错误消息）

**定位**：`game-room.ts:724-726`

```typescript
if (this.game.round !== 'showdown') {
  return;  // ← 静默返回，客户端不知道发生了什么
}
```

**对比**：同文件中其他 guard 用 `this.sendError(ws, '...')` 或 `this.sendToAll('...')`。

**修复方向**：与 H4 的 winner 校验合并，统一错误处理：
```typescript
if (this.game.round !== 'showdown') {
  this.sendToAll('当前不在摊牌阶段');
  return;
}
```

---

### M8. normalizeDealerIndex 死代码

**定位**：`game-room.ts:712-721`

```typescript
private normalizeDealerIndex(): void {
  if (this.game.players.length === 0) {
    this.game.dealerIndex = 0;
    return;
  }
  this.game.dealerIndex = Math.min(this.game.dealerIndex, this.game.players.length - 1);
  this.game.players.forEach((player, index) => {
    player.position = (index - this.game.dealerIndex + this.game.players.length) % this.game.players.length;
  });
}
```

**检测结果**：在整个 `src/` 目录中无任何调用方。搜索 `normalizeDealerIndex` 仅命中定义本身。

**影响**：无运行时影响（死代码不执行），但增加了代码阅读负担——读者可能误以为 position 通过此方法分配（实际由 `assignPositions` 分配）。

**修复方向**：直接删除。Git 历史可恢复。若担心将来需要——当前 `dealerIndex` 通过 `handleStartHand` 中的 `nextActiveIndex` 保证有效；玩家数组的元素从不删除（只标记 isConnected=false），数组不会塌缩。

---

## 4. 低 (Low)

### L1. `lastActor` 字段冗余

**定位**：`src/types.ts` — `GameState.lastActor: string` 与 `GameState.lastAction: string` 功能重叠。

**修复**：移除此字段需前后端同步——`PublicGameState` 的类型定义和 `publicState()` 方法中也要移除。前端 `render.js` 需检查是否引用了 `lastActor`（当前搜索显示未引用）。

---

### L2. `JSON.stringify` 脏检查执行两次

**定位**：`game-room.ts:208` 和 `game-room.ts:235` — 同一次 `webSocketMessage` 调用中对 `this.game` 做两次序列化。

```typescript
const stateBefore = JSON.stringify(this.game);  // line 208
// ... dispatch ...
if (JSON.stringify(this.game) !== stateBefore) { // line 235
  await this.save();
}
```

**影响**：微性能损耗（GameState JSON < 10KB，可忽略）。

**修复**：已足够高效，无需修改。此处记录供参考。

---

### L3. RoomRegistry 过期清理依赖 alarm

**定位**：`src/room-registry.ts`

**问题**：如果 RoomRegistry DO 的 alarm 未触发（例如 DO 在 alarm 触发前被删除），注册表条目会残留。

**影响**：极低——残留条目仅占用极少量 SQLite 空间，且 `claim()` 在注册前会检查是否已存在（返回 false）。不会导致房号冲突。

---

### L4. `worker-configuration.d.ts` (542KB) 提交到 git

**问题**：自动生成文件体积大，占仓库空间。

**修复**：在 `.gitignore` 中添加 `worker-configuration.d.ts`，已在 TECHNICAL.md 的目录结构中标注忽略。

---

### L5. `.DS_Store` 在 git 跟踪中

**修复**：`echo '.DS_Store' >> .gitignore && git rm --cached .DS_Store`

---

### L6. `activePlayers` 变量命名误导

**定位**：`game-room.ts:484`

```typescript
const activePlayers = this.game.players.filter(p => !p.isFolded);
```

**问题**：变量名含 "active" 但过滤条件不含 `isActive`。实际语义是 "contestingPlayers"（争夺底池的玩家）。

**修复**：重命名为 `contestingPlayers`，与注释（第 482-483 行）一致。

---

### L7. 服务端 raise amount 防御性检查缺失

**定位**：`game-room.ts:447`

```typescript
const raiseAmount = amount || this.game.bigBlind;
```

**问题**：`amount` 为负数或 `NaN` 时行为不确定。没有 `Math.max(0, raiseAmount)` 防御。

**修复**：加 `const raiseAmount = Math.max(1, amount || this.game.bigBlind);`

---

## 5. 耦合与约束地图

> ⚠️ 以下信息对安全修改至关重要。在你动手改任何东西之前，先查本节。

### 5.1 修改影响链

```
                    ┌──────────────────────────────┐
                    │        src/types.ts           │
                    │  Player, GameState, Round...  │
                    └──────────────┬───────────────┘
                                   │ 类型变更会影响所有下游
          ┌────────────────────────┼────────────────────────┐
          ▼                        ▼                        ▼
┌─────────────────┐    ┌─────────────────────┐    ┌─────────────────┐
│  game-room.ts   │    │  public/scripts/    │    │  test/          │
│  (核心逻辑)      │    │  render.js          │    │  game-room.test │
│                 │    │  (含同源谓词副本)     │    │                 │
└────────┬────────┘    └──────────┬──────────┘    └─────────────────┘
         │                        │
         │    ┌───────────────────┘
         │    │  改以下 4 个谓词时，必须两端同步
         │    ▼
         │  ┌──────────────────────────────────┐
         │  │  同源逻辑（见 §5.2）              │
         │  │  - isRoundComplete()             │
         │  │  - 可行动者过滤 (advanceTurn)     │
         │  │  - 候选获胜者过滤                 │
         │  │  - 位置标签 (D/SB/BB)             │
         │  └──────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│  index.ts       │
│  (路由, 房号     │
│   正则, 过期检查) │
└─────────────────┘
```

### 5.2 前后端同源逻辑清单

以下逻辑在 `src/game-room.ts` 和 `public/scripts/render.js` 中**各有一份实现**。修改任一端必须同步另一端。

| # | 逻辑 | 后端位置 | 前端位置 | 当前同步状态 |
|---|------|----------|----------|-------------|
| 1 | `isRoundComplete()` | `game-room.ts:523-531` | `render.js:215-220` | ✅ 同步（逐字一致） |
| 2 | 可行动者过滤 | `game-room.ts:515` (advanceTurn) | `render.js:177` (isMyTurn) | ⚠️ 前端少 `isActive` 字段（见 M4） |
| 3 | 可行动者过滤 | `game-room.ts:524-525` (isRoundComplete) | `render.js:118` (isTurn CSS) | ⚠️ 前端少 `isActive` 字段（见 M4） |
| 4 | 可行动者过滤 | `game-room.ts:667` (setFirstToAct) | `app.js:125-126` (notifyMyTurn) | ⚠️ 前端少 `isActive` 和 `isSittingOut`（见 M4） |
| 5 | D/SB/BB 位置标签 | `game-room.ts:702-710,618-621` | `render.js:96-107` | ✅ 同步（算法等价） |
| 6 | 候选获胜者过滤 | `game-room.ts:484` (!isFolded) | `render.js:205` (!isFolded && !isSittingOut) | ⚠️ 故意不同（见 TECHNICAL.md §6.2） |
| 7 | toCall 计算 | `game-room.ts:413` | `render.js:186` | ✅ 同步 |

**修改协议**：
1. 改后端谓词 → 搜索前端同名函数/表达式 → 同步修改
2. Commit message 标注 `sync:` 前缀，提醒 reviewer 关注两端一致性
3. 怀疑不同步时 → grep 前端代码找对应逻辑 → 逐行对比

### 5.3 不可触碰的不变量

这些是历史上有过血泪教训的规则。变更涉及以下代码时，**先读 TECHNICAL.md §6.1 和 §6.2**，确认你的修改不破坏不变量。

#### 行动顺序不变量（§6.1）

| 场景 | 规则 | 实现位置 |
|------|------|----------|
| 多人翻牌前 | UTG 先动 = BB 下家 | `game-room.ts:660-661` |
| 多人翻牌后 | SB 先动 = dealer 下家 | `game-room.ts:662` |
| 单挑翻牌前 | SB(=庄家) 先动 | `game-room.ts:656-657` |
| **单挑翻牌后** | **BB 先动**（SB/庄家最后） | `game-room.ts:658` |

⚠️ **单挑翻牌后 BB 先动曾被误当 bug 改错又回退。** 不要重蹈覆辙。

#### 断线坐出不变量（§6.2）

| 规则 | 实现位置 |
|------|----------|
| "可行动" = `!isFolded && isActive && !isAllIn && !isSittingOut` | `game-room.ts:515, 524-525, 667` |
| "争夺底池" = `!isFolded`（含 sitting-out，防止独赢） | `game-room.ts:484` |
| 断线后不 fold、不出局、不付筹码 | `game-room.ts:352-365` |
| 手牌中重连保持 sitting-out，下局复活 | `game-room.ts:292-294` + `game-room.ts:604` |
| 先注册新连接再关旧连接（防误判离线） | `game-room.ts:302-308` |

#### 盲注防御不变量

| 规则 | 实现位置 |
|------|----------|
| SB ≠ BB 永远成立 | `game-room.ts:625-628` |
| 单挑时 dealer 即 SB | `game-room.ts:618-619` |

#### DO 运行约束

| 规则 | 说明 |
|------|------|
| SQLite-backed DO | `wrangler.toml` 必须用 `new_sqlite_classes`，不能改回 `new_classes` |
| Hibernation API | 通过 `serializeAttachment` 存 playerId，不在构造函数之外持有 WebSocket 引用 |
| 状态持久化 | `save()` → `ctx.storage.put('game', this.game)`；所有修改后必须显式 `await this.save()` |
| 无热更新 | 后端改动 → 必须 `wrangler deploy`；DO 状态跨部署保留 |

### 5.4 测试覆盖缺口

| 缺口 | 优先级 | 建议 |
|------|--------|------|
| 单挑翻牌后 BB 先动 | 中 | 见 M6 |
| Raise currentBet=0 时最低限额 | 高 | 见 H1 |
| 全体 All-in 后自动推进 | 高 | 见 H2 |
| handleEndHand winner 校验 | 高 | 见 H4 |
| 每日重置绕过活跃牌局 | 严重 | 见 C1 |
| awardPot 不存在 winnerId | 中 | 见 M1 |
| waiting 重连清除 isSittingOut | 低 | 见 disconnect audit Rule 5 |

---

## 6. 修复优先级路线图

### 第一阶段：立即修复（安全性 + 数据完整性）

| 优先级 | Issue | 预估改动量 | 风险 |
|--------|-------|-----------|------|
| 🔴 C1 | 每日重置摧毁牌局 | ~30 行 game-room.ts | 中—需验证 Hibernation 唤醒路径 |
| 🟠 H4 | handleEndHand winner 校验 | ~8 行 game-room.ts | 低—纯增量校验 |
| 🟠 M1 | awardPot winnerId 存在性校验 | ~5 行 game-room.ts | 低—纯增量校验 |

### 第二阶段：规则完善

| 优先级 | Issue | 预估改动量 | 风险 |
|--------|-------|-----------|------|
| 🟠 H1 | Raise currentBet=0 限额 | 1 行 game-room.ts（删条件） | 中—需新增测试 |
| 🟡 M3 | BB 短码 currentBet 锁定 | 1 行 game-room.ts | 低 |
| 🟡 M2 | Solo-survivor 检测扩展 | ~20 行 game-room.ts | 中—涉及 markDisconnected |

### 第三阶段：UX 与同步

| 优先级 | Issue | 预估改动量 | 风险 |
|--------|-------|-----------|------|
| 🟠 H2 | 全体 All-in 自动推进 | ~30 行 game-room.ts | 中—需处理 communityCards 跳变 |
| 🟡 M4 | 前端谓词补全 | 3 处 × 各 1 行 JS | 低—纯补字段 |
| 🟡 M5 | 前端 raise min 动态绑定 | ~5 行 render.js + actions.js | 低 |

### 第四阶段：清理与测试

| 优先级 | Issue | 预估改动量 | 风险 |
|--------|-------|-----------|------|
| 🟡 M8 | 删除 normalizeDealerIndex | 删 ~10 行 | 无 |
| 🟢 L1-L7 | 清理类问题 | 各 1-5 行 | 无 |
| 🟡 M6 | 新增单挑翻牌后测试 | ~30 行 test | 无 |

### 未来架构级改动（与 Plan B React 重写同步）

| Issue | 说明 |
|-------|------|
| H3 Side Pot | 需 GameState 类型变更 + handleAction 重写 + awardPot 重写 + 前端 UI 改造 |
| 主动轮转 (auto-action-loop) | 将"全体 all-in 自动推进"泛化为通用的"无可行动者时自动推进" |

---

## 附录：审计方法说明

本次审计由 8 个独立 AI Agent 并行执行，每个 Agent 分配一个维度，独立审查代码并给出 PASS/FAIL/GAP 判定。维度划分：

1. **盲注规则** — `postBlinds()`, `nextActiveIndex()`, `nextDifferentActiveIndex()`
2. **下注与操作** — `handleAction()`, `advanceTurn()`, `isRoundComplete()`, `resetActedFlags()`, 前端 `actions.js`
3. **轮次推进** — `handleNextRound()`, `handleEndHand()`, `handleStartHand()`
4. **底池分配与胜者** — `awardPot()`, `handleEndHand()`, `handleAction` solo-survivor
5. **断线与坐出** — `markDisconnected()`, `handleJoin()`, `webSocketClose()`, `startHand`
6. **行动顺序** — `setFirstToAct()`, `advanceTurn()`, `nextActiveIndex()`
7. **前后端同步** — `render.js` vs `game-room.ts` 谓词逐行对比
8. **边缘案例与已知问题** — 12 种极端场景 + TECHNICAL.md documented issues

所有 Agent 的结果经过汇总、去重、严重度分级后形成本文档。
