# 风险评估与 AI 可执行改进任务

> 配套：[README.md](../README.md) · [TECHNICAL.md](./TECHNICAL.md)  
> 产品：熟人线下德扑**计分器**（Cloudflare Workers + GameRoom DO）  
> 用法：人类用 §1–2 判断优先级；**Agent 只领一张任务卡（§4）执行**，勿一次做多卡。

---

## 0. 给 AI Agent 的强制协议

在领取任一 `Txx` 任务前，必须遵守：

1. **一次只做一个 Task ID**。完成后停下来汇报，等人类确认再开下一张。
2. **只读「必读文件」+ 任务写明的可选文件**。禁止为「全面了解」通读全仓库（会浪费窗口且易越界改动）。
3. **禁止触碰「Out of scope」与「全局禁改」**。不确定就停，写在报告里。
4. **验收以任务卡「Done 定义」为准**，不是「感觉做完了」。
5. 改后端谓词 / 结算 / 断线语义时，必须先读 TECHNICAL 对应不变量（任务卡会写明章节）。
6. 单任务目标体积：改动通常 **≤ 5 文件、≤ ~150 行净变更**；测试任务可再加 `test/` 内一块 `describe`。
7. 验证命令写在卡上；默认 `npx tsc --noEmit`，涉及逻辑再 `npm test`（pool 慢可只跑相关 `it` 名）。
8. **不要** deploy，除非任务卡明确写「允许 deploy」且人类授权。
9. Commit 信息建议：`Txx: <标题>`；不要把多张卡塞进一个 commit。

### 全局禁改（除非任务卡明文授权）

| 禁改 | 原因 |
|------|------|
| 断线 → fold / `isActive=false` 收缩环 | 坐出不变量 |
| 单挑翻牌后改为 SB 先动 | 标准 NLHE；历史误修过 |
| 删除边池 / 简化 `awardPotsByTiers` 为均分 pot | 多路 all-in 会分错钱 |
| 把 `new_sqlite_classes` 改回 `new_classes` | Free Tier 不兼容 |
| 引入 React/构建链/账号系统 | 超出计分器定位 |

### 窗口预算约定（200k）

| 角色 | 预算建议 |
|------|----------|
| 系统 + TECHNICAL 片段 + 任务卡 | ~30–50k |
| 必读源码（2–4 文件） | ~40–80k |
| 编辑与 diff | ~20–40k |
| 余量（测试输出 / 返工） | ≥30k |

若必读文件合计将超过 ~100k token，**先拆任务**，不要硬做。

---

## 1. 总体判断（给人类）

| 维度 | 判断 |
|------|------|
| 能否上桌用 | 能。记分闭环完整 |
| 最大风险 | 误操作分错钱；改规则时前后端分叉 |
| 要不要大重构 | 不要。按任务卡小步做 |
| 瘦身原则 | 删噪音可以；砍断线/边池/sync 不行 |

---

## 2. 风险速查（压缩）

| ID | 优先级 | 一句话 | 对应任务 |
|----|--------|--------|----------|
| R1 | P1 | 无权限，任何人可结算/改盲注/补码/踢人 | T03 T04 T05 T06 T18 |
| R2 | P1 | 胜负靠人手点，点错服务端也照分 | T09 T10 T11 |
| R3 | P1 | 最小加注≠标准「上次加注额」等简化 | T19；文档已说明 |
| R4 | P1 | 北京 04:00 / 7 天 TTL 会**毁房**（waiting） | T16 T17 |
| R5 | P1 | 前后端各写一份 `isRoundComplete` 等 | T07 T08 |
| R6 | P3 | 无鉴权；房号泄露即可进 | T22（可选） |
| R7 | P2 | deploy 无热更 + SW 缓存易旧 | T24 |
| R8 | P2 | 无 CI；关键规则缺钉死用例 | T12–T15 T23 |
| R9 | P3 | `lastActor` / 未用 hono 等噪音 | T01 T02 |
| R10 | P2 | 已修逻辑的回退风险 | T12–T15 + 全局禁改 |

详细现象与历史背景见文末 [附录 A](#附录-a风险展开只读不执行)。

---

## 3. 任务总表与依赖

```
T01 删 hono
T02 删 lastActor
T03 信任模型文案
T04 改盲注确认
T05 给他人补码确认
T06 结算前简单确认（无预览）
     │
T07 roundComplete 后端 ──► T08 前端改用 roundComplete
     │
T09 抽出 planPots 纯函数 ──► T10 preview 协议 ──► T11 预览 UI
     │
T12 测：单挑 flop BB 先动
T13 测：不足额 all-in 不重开
T14 测：挂机不独赢
T15 测：边池退还/拒绝（若已有则 skip 补洞）
T16 展示过期/清理时间
T17 soft reset（依赖产品确认；可后做）
T18 轻量 host（依赖产品确认）
T19 lastRaiseSize（大规则，单独做）
T20 serverVersion
T21 notice 消息类型
T22 入桌口令
T23 CI workflow
T24 deploy checklist 脚本提示
T25 两人桌简化摊牌 UI
```

**推荐默认顺序（阶段 1）**  
`T03 → T04 → T05 → T06 → T07 → T08 → T12 → T13 → T14 → T09 → T10 → T11 → T01 → T02 → T23 → T24`

每张卡预计 **单 Agent 一轮对话内完成**（含 typecheck；全量 test 视环境）。

---

## 4. 任务卡（AI 精确执行单元）

每张卡固定字段：

- **Goal**：一句话成功标准  
- **Why**：为何做  
- **Depends on**：前置 Task；无则 `—`  
- **必读文件**：允许 Read 的完整列表  
- **可写文件**：允许修改的完整列表  
- **In / Out of scope**  
- **实现要点**：足够开工的技术说明（勿自由发挥）  
- **Done 定义**：可勾选  
- **验证**  
- **窗口提示**：预计规模  

---

### T01 — 移除未使用的 hono 依赖

| | |
|--|--|
| **Goal** | `package.json` 不再依赖 `hono`，安装与类型检查正常 |
| **Why** | 路由是手写 `fetch`，hono 为噪音依赖 |
| **Depends on** | — |
| **必读** | `package.json`；`package-lock.json`（仅确认）；`rg hono` 全仓（不含 node_modules） |
| **可写** | `package.json`；`package-lock.json`（npm uninstall 生成） |
| **In scope** | 确认无 `import` 后 `npm uninstall hono` |
| **Out of scope** | 任何业务代码、换路由框架 |
| **实现要点** | 1) `rg "from ['\"]hono|require\\(['\"]hono"` 必须 0 命中 2) `npm uninstall hono` 3) 勿手改 lock 到不一致 |
| **Done** | [x] 无 hono 依赖 [x] `npx tsc --noEmit` 通过 [x] `npm ls hono` 失败或 empty |
| **验证** | `rg hono --glob '!node_modules/**' -g '*.{ts,js,json}'`；`npx tsc --noEmit` |
| **窗口** | S；几乎不读业务代码 |

---

### T02 — 删除冗余字段 `lastActor`

| | |
|--|--|
| **Goal** | 协议与存储中不再出现 `lastActor`；行为仅依赖 `lastAction` |
| **Why** | 与 `lastAction` 重叠，增加协议噪音 |
| **Depends on** | — |
| **必读** | `src/types.ts`；`src/game-room.ts` 中所有 `lastActor` 命中上下文；`rg lastActor`；`public/scripts` 若有引用 |
| **可写** | `src/types.ts`；`src/game-room.ts`；`test/game-room.test.ts`（仅当测试断言该字段） |
| **In scope** | 从 `GameState` / `PublicGameState` 删除字段；删除赋值；`publicState()` 不再输出 |
| **Out of scope** | 改 `lastAction` 文案格式；任何 UI 重做 |
| **实现要点** | 1) 类型双删 2) `loadOrCreate` 初始对象删键 3) `handleAction` 里 `this.game.lastActor = ...` 删除 4) `publicState` 删 5) 旧 DO 存档可能仍带该键——读入时忽略即可，不必 migration |
| **Done** | [ ] `rg lastActor` 仅可能出现在本文档 [ ] tsc 通过 [ ] 相关 test 通过 |
| **验证** | `rg lastActor --glob '!docs/**' --glob '!node_modules/**'`；`npx tsc --noEmit` |
| **窗口** | S |

---

### T03 — 大厅/文档明示「无房主、任何人可操作」

| | |
|--|--|
| **Goal** | 用户在大厅能看到一句清晰说明；README 一句同步 |
| **Why** | 降低「我以为只有房主能结算」的预期落差（R1） |
| **Depends on** | — |
| **必读** | `public/index.html`（lobby 区块）；`public/scripts/render.js` `renderLobby`；`README.md` 局限节 |
| **可写** | `public/index.html` 或 `render.js`（二选一加提示）；`public/styles.css`（可选极简样式）；`README.md` |
| **In scope** | 可见文案 + README 一句 |
| **Out of scope** | 权限系统、禁用按钮、host |
| **实现要点** | 文案示例：「本桌任何人可开始游戏、改盲注、结算与补码，操作前请桌内口头确认。」放在 lobby 盲注设置上方或 footer 附近；勿改游戏逻辑 |
| **Done** | [ ] 大厅可见 [ ] README 有对应说明 [ ] 无逻辑变更 |
| **验证** | 目视 diff；无需 test |
| **窗口** | S |

---

### T04 — 修改盲注前二次确认

| | |
|--|--|
| **Goal** | 用户改 SB/BB 触发设置前必须确认，取消则不发送 `updateSettings` |
| **Why** | 防误触改盲注（R1） |
| **Depends on** | — |
| **必读** | `public/scripts/actions.js` `updateSettings`；`public/index.html` 盲注 input 的 `onchange` |
| **可写** | `public/scripts/actions.js`；必要时 `public/index.html` |
| **In scope** | `confirm` 或已有 modal 模式；取消不 `send` |
| **Out of scope** | 服务端校验加强、host 权限 |
| **实现要点** | 在 `updateSettings()` 内：`parse` 后、`send` 前 `if (!confirm(\`将盲注改为 SB ${sb}/BB ${bb}？\`)) return;`；非法 bb<=sb 仍前端先挡 |
| **Done** | [ ] 取消不发包 [ ] 确认仍发包 [ ] 不改后端 |
| **验证** | 代码审阅；可选本地手测 |
| **窗口** | S |

---

### T05 — 给**他人**补码前二次确认

| | |
|--|--|
| **Goal** | `rebuy(targetId)` 当 target ≠ 自己时确认；给自己可保持一键或同样确认（实现选「他人必确认」） |
| **Why** | 防误给别人 +1000（R1） |
| **Depends on** | — |
| **必读** | `public/scripts/actions.js` `rebuy`；`public/scripts/app.js` 大厅 rebuy 点击；如何取 `myPlayerId`（`socket.getMyPlayerId` 或 app 传入） |
| **可写** | `actions.js`；`app.js`（若需传入 myId） |
| **In scope** | 仅前端确认 |
| **Out of scope** | 改 rebuy 默认金额、服务端权限 |
| **实现要点** | `rebuy(targetPlayerId, amount)`：若 `targetPlayerId && targetPlayerId !== getMyPlayerId()`，`confirm('确定给该玩家补码？')`；否 return |
| **Done** | [ ] 他人补码可取消 [ ] 自己补码行为明确且不回归 |
| **验证** | 代码审阅 |
| **窗口** | S |

---

### T06 — 摊牌「确认结算」前二次确认（无金额预览）

| | |
|--|--|
| **Goal** | 点「确认结算」后先 `confirm`，再 `send endHand` |
| **Why** | 在完整预览（T11）之前，先用零依赖降误触；可与 T11 并存（T11 可替换为预览页内确认） |
| **Depends on** | —（T11 完成后可删重复 confirm，属 T11 范围） |
| **必读** | `public/scripts/actions.js` `confirmTiers`；`render.js` `getTiers` |
| **可写** | `actions.js` |
| **In scope** | 一条 confirm，文案含已选档位数 |
| **Out of scope** | 边池金额计算、新协议 |
| **实现要点** | `const tiers = getTiers(); if (!tiers.length) return; if (!confirm(\`确认按 ${tiers.length} 个名次档结算？\`)) return; send(...)` |
| **Done** | [ ] 取消不 send [ ] 确认行为与现网一致 |
| **验证** | 代码审阅 |
| **窗口** | S |

---

### T07 — 后端下发 `roundComplete`

| | |
|--|--|
| **Goal** | `PublicGameState` 增加 `roundComplete: boolean`，与 `isRoundComplete()` 一致 |
| **Why** | 为 T08 删除前端副本做 SSOT（R5） |
| **Depends on** | — |
| **必读** | `src/types.ts` `PublicGameState`；`src/game-room.ts` `isRoundComplete`、`publicState`；TECHNICAL §9 一段 |
| **可写** | `src/types.ts`；`src/game-room.ts` |
| **In scope** | 字段定义 + `publicState()` 内赋值 |
| **Out of scope** | 改前端；改 `isRoundComplete` 语义；改 advance 逻辑 |
| **实现要点** | ```ts\n// publicState():\nroundComplete: this.isRoundComplete(),\n``` 仅在 round 为 preflop/flop/turn/river 时有意义；waiting/showdown 可固定 `false`：`['preflop','flop','turn','river'].includes(this.game.round) && this.isRoundComplete()` |
| **Done** | [ ] 类型有字段 [ ] publicState 输出 [ ] tsc 通过 [ ] 语义与 private 方法一致 |
| **验证** | `npx tsc --noEmit`；可选手测 `/state` JSON |
| **窗口** | S–M；只动 publicState 与 types |

---

### T08 — 前端用 `state.roundComplete`，移除本地 `isRoundComplete` 决策

| | |
|--|--|
| **Goal** | 行动栏「下一轮」是否显示只信 `state.roundComplete`；删除或停止导出用于决策的本地完整实现 |
| **Why** | 消灭同源分叉（R5） |
| **Depends on** | **T07**（旧服务器无字段时需兼容：`state.roundComplete === true` 或 fallback） |
| **必读** | `public/scripts/render.js` `renderActionBar`、`isRoundComplete`；确认无其它文件 import `isRoundComplete` |
| **可写** | `render.js`；若有 import 则对应文件 |
| **In scope** | 决策改字段；可留 private fallback 一版并标 `@deprecated` 仅当 `roundComplete === undefined`（兼容未升级后端） |
| **Out of scope** | 改 `isMyTurn`；改后端 |
| **实现要点** | `const done = state.roundComplete === true || (state.roundComplete === undefined && isRoundComplete(state));` 然后 T07 部署稳定后开 follow-up 删 fallback——**本卡允许保留 fallback**，但主路径必须优先字段 |
| **Done** | [ ] 主路径读 `roundComplete` [ ] 有注释说明 fallback [ ] 不改谓词四字段定义 |
| **验证** | 代码审阅；与 T07 联调时点「下一轮」仍只在结束时出现 |
| **窗口** | S |

---

### T09 — 抽出 `planPotsByTiers` 纯函数（无行为变化）

| | |
|--|--|
| **Goal** | 边池「规划阶段」变成可单测纯函数；`awardPotsByTiers` 先 plan 再 apply，**筹码结果与重构前一致** |
| **Why** | 为 T10/T11 预览共用同一算法，避免预览/实结算分叉（R2） |
| **Depends on** | — |
| **必读** | `src/game-room.ts` 全文 `awardPotsByTiers`（约 865–962 行一带）；`src/types.ts` `SidePot`/`Player` |
| **可写** | **优先** 新建 `src/pot-settlement.ts` 导出纯函数；`game-room.ts` 改为调用；可选 `test/pot-settlement.test.ts` **纯 Node/vitest 不依赖 DO 亦可** |
| **In scope** | 提取 + 委托 + 保持返回 `{ok}` 语义；可加 2–3 个纯函数单测 |
| **Out of scope** | 改分层规则；新 WS 消息；前端；「优化」分配公式 |
| **实现要点** | 1) 签名建议：`planPotsByTiers(players: {id,name,totalBet,isFolded}[], pot: number, tiers: string[][]) => { ok:true, plans: LayerPlan[] } \| { ok:false, message }` 2) `awardPotsByTiers` 调 plan，失败 return；成功再写 chips/`sidePots` 3) **禁止**在提取时「顺手」改 remainder 归属等细节 4) 对照现有 side pot 测试必须仍绿 |
| **Done** | [ ] 纯函数在独立模块 [ ] game-room 无重复规划循环 [ ] 现有 side pot 相关 test 通过 [ ] tsc 通过 |
| **验证** | `npx tsc --noEmit`；`npm test`（或至少 side pot describe） |
| **窗口** | M；核心是精确搬移，勿扩张 |

---

### T10 — 只读结算预览协议 `previewEndHand`

| | |
|--|--|
| **Goal** | 客户端可发预览请求，收到计划明细或错误，**不修改**筹码/round |
| **Why** | UI 预览需要权威后端结果（R2） |
| **Depends on** | **T09** |
| **必读** | `src/types.ts` `ClientMessage`/`ServerMessage`；`game-room.ts` `webSocketMessage`、`handleEndHand`、plan 函数；T09 模块 |
| **可写** | `src/types.ts`；`src/game-room.ts`；可选 test 一条 |
| **In scope** | 新 type；handler；响应格式 |
| **Out of scope** | 前端 UI（T11）；改 award 规则 |
| **实现要点** | 1) `ClientMessage.type` 增加 `'previewEndHand'`，复用 `tiers`/`winnerIds` 2) `ServerMessage` 增加例如 `type:'preview'` + `preview?: { pots: {amount, winnerIds, winnerNames?}[], message?: string }` 或失败走 `error` 3) handler：round 必须 showdown；校验同 `handleEndHand`；调 `planPotsByTiers`；**不**改 `this.game` 4) dirty check 应因无变更而不 save 5) 与 `endHand` 校验逻辑可抽小函数 `normalizeTiers(msg)` 避免复制粘贴错误——若抽，仅限 endHand/preview 共用 |
| **Done** | [ ] 预览不改 pot/chips/round [ ] 非法 tiers 返回明确错误 [ ] 合法返回与将要结算一致的金额切分 [ ] tsc + 至少 1 测或手测说明 |
| **验证** | test 或文档化 curl/WS 步骤；`npx tsc --noEmit` |
| **窗口** | M |

---

### T11 — 前端结算预览 UI

| | |
|--|--|
| **Goal** | 用户选完档位后先看到「谁赢多少」，确认后再 `endHand` |
| **Why** | 关闭误分钱路径（R2） |
| **Depends on** | **T10**（及已部署含 preview 的后端） |
| **必读** | `actions.js` `confirmTiers`；`render.js` 摊牌渲染；`socket.js` `send`/`onMessage`；T10 响应形状 |
| **可写** | `actions.js`；`render.js`；`app.js`（消息分支）；`index.html`/`styles.css` 若需预览区域 |
| **In scope** | 预览请求 → 展示 → 确认 endHand / 取消回选档 |
| **Out of scope** | 改边池算法；host 权限 |
| **实现要点** | 1) 「确认结算」先 `send({type:'previewEndHand', tiers})` 2) 收 `preview` 后渲染列表 3) 二次按钮真正 `endHand` 4) 若 T06 的 window.confirm 仍在，改为预览页按钮，去掉重复 5) cache bust：`?v=` 与 sw cache **本卡必须 bump** |
| **Done** | [ ] 未见预览不能 endHand [ ] 预览金额与结算后 lastAction/sidePots 一致 [ ] 取消可返回改档 [ ] 静态资源版本已 bump |
| **验证** | 手测两人平分 + 三人边池；tsc 不涉及则略 |
| **窗口** | M；勿同时做 T18/T25 |

---

### T12 — 测试：单挑翻牌后 BB 先动

| | |
|--|--|
| **Goal** | 自动化锁定「2 人桌 flop 首动 = BB」 |
| **Why** | 历史误修；防回归（R10 / TECHNICAL §7.1） |
| **Depends on** | — |
| **必读** | `test/game-room.test.ts` 现有 2 人桌用例与 helper（TestSocket 等）；`setFirstToAct` 注释 |
| **可写** | **仅** `test/game-room.test.ts` |
| **In scope** | 一个 `it(...)` |
| **Out of scope** | 改 production 代码「让测试通过」——若失败先报告，不擅自改规则 |
| **实现要点** | 建房→2 join→startHand→完成 preflop 下注至可 nextRound→nextRound 到 flop→`expect(state.currentPlayerIndex).toBe(bbIndex)`；用已有模式推进街道，勿新造框架 |
| **Done** | [ ] 新 it 存在 [ ] 本地 test 该 it 通过 [ ] 无 src 变更 |
| **验证** | `npx vitest run -t '单挑翻牌后'` 或等价 |
| **窗口** | S–M（pool 启动占时间，不占上下文） |

---

### T13 — 测试：不足额 all-in 不完整重开

| | |
|--|--|
| **Goal** | 覆盖「all-in 加注幅度 < bigBlind 时不 `resetActedFlags`」的可观察行为 |
| **Why** | 防回归（game-room raise 分支注释） |
| **Depends on** | — |
| **必读** | `game-room.ts` raise all-in 分支；现有 all-in 测试；test helpers |
| **可写** | 仅 `test/game-room.test.ts` |
| **In scope** | 一个 it：构造短码 all-in < BB 加幅，断言已行动玩家无需面对「被重开的加注轮」的错误状态（按现有状态机可观察字段：`hasActedThisRound` / 是否仍能 raise 等——**以代码现状设计断言，并在 it 注释写清期望**） |
| **Out of scope** | 改 raise 规则 |
| **Done** | [ ] it 绿 [ ] 无 src 变更 |
| **验证** | vitest -t 关键字 |
| **窗口** | M |

---

### T14 — 测试：断线挂机不导致另一人独赢

| | |
|--|--|
| **Goal** | 2 人局一人断线 → 不自动 award 给另一人；底池仍在 |
| **Why** | 坐出不变量核心（R10 / TECHNICAL §7.2） |
| **Depends on** | — |
| **必读** | 现有「断线坐出」describe；`markDisconnected`/`checkSoloSurvivor` |
| **可写** | 仅 `test/game-room.test.ts` |
| **In scope** | 巩固或补洞 it（若已有完全等价则 **Done = 注明已有用例名并 skip 新增**） |
| **Out of scope** | 改 markDisconnected |
| **Done** | [ ] 有绿色覆盖 [ ] 报告写明用例名 |
| **验证** | vitest |
| **窗口** | S |

---

### T15 — 测试：边池「未排满拒绝」与「单人层自动」

| | |
|--|--|
| **Goal** | 纯行为锁定 plan/award 的拒绝与自动归属分支 |
| **Why** | 结算守恒（R2/R10） |
| **Depends on** | T09 后更易测纯函数；**无 T09 也可**对 WS endHand 测 |
| **必读** | 现有 Side pot describe；`awardPotsByTiers` / plan 模块 |
| **可写** | `test/game-room.test.ts` 和/或 `test/pot-settlement.test.ts` |
| **In scope** | 缺的分支各 1 it |
| **Out of scope** | 改算法 |
| **Done** | [ ] 拒绝路径有断言 message [ ] 自动归属路径筹码正确或标注已有 |
| **验证** | vitest |
| **窗口** | M |

---

### T16 — 向客户端展示房间过期/下次清理时间

| | |
|--|--|
| **Goal** | 大厅可见「房间过期时间」或「下次清理估计」，减少凌晨毁房惊讶（R4） |
| **Depends on** | — |
| **必读** | `types.ts` GameState `expiresAt`；`publicState`；`nextCleanupOrExpiry`（只读理解）；`renderLobby` |
| **可写** | `types.ts`（PublicGameState 可增加 `expiresAt: number`）；`game-room.ts` `publicState`；`render.js` 展示；可选 styles |
| **In scope** | 下发已有 `expiresAt` + 格式化显示（本地时区） |
| **Out of scope** | 改 alarm 策略（那是 T17）；精确到「下一次 04:00」若需新字段可只做 expiresAt |
| **实现要点** | publicState 加 `expiresAt: this.game.expiresAt`；UI：`新 Date(expiresAt).toLocaleString()`；文案「房间将于 … 后不可用」 |
| **Done** | [ ] state 含字段 [ ] 大厅可见 [ ] 不改销毁逻辑 |
| **验证** | 手测；tsc |
| **窗口** | S |

---

### T17 — 每日清理改为 soft reset（保留房间与玩家）

| | |
|--|--|
| **Goal** | 北京 04:00 在 waiting 时重置牌局进度/筹码策略，**不** `deleteAll` 房间；TTL 仍可硬删 |
| **Why** | 固定牌友想长期用同一房码（R4） |
| **Depends on** | **人类先选定筹码策略**：A 全部回 `DEFAULT_CHIPS` / B 保持筹码只清 hand 状态。未选定则 **禁止开工** |
| **必读** | `alarm` 全文；`loadOrCreate`；TECHNICAL §7.4–7.5；`RoomRegistry` |
| **可写** | `game-room.ts`；测试每日清理 describe；TECHNICAL 同步一句 |
| **In scope** | 拆 soft/hard；soft 不 remove registry |
| **Out of scope** | 改 7 天 TTL 语义；前端大改 |
| **实现要点** | `if (!ttlExpired && waiting) { softReset(); setAlarm(next); return; }`；`softReset` 清 pot/round/handNumber/sidePots 等；玩家列表保留；`playerDevices` 保留；broadcast；**进行中推迟 15 分钟逻辑保留** |
| **Done** | [ ] waiting 日切后同 roomId 仍 exists [ ] TTL 到期仍销毁 [ ] 测试更新 [ ] 文档一句 |
| **验证** | 更新后的 alarm 测试；tsc |
| **窗口** | M–L 边界；严格按策略，勿兼做 host |

---

### T18 — 轻量 Host（deviceId）

| | |
|--|--|
| **Goal** | 建房后首个成功 join 的 deviceId 为 host；敏感写操作仅 host |
| **Why** | 降 R1 恶意/误触（比 confirm 更强） |
| **Depends on** | 人类确认敏感列表默认：`endHand` `updateSettings` `removePlayer` 他人`rebuy`；`startHand`/`nextRound`/`action` **建议仍开放** |
| **必读** | `handleJoin`；`playerDevices`；各 handle；types |
| **可写** | `types.ts`；`game-room.ts`；前端：非 host 隐藏/禁用敏感按钮（render/app）；test 2 it |
| **In scope** | hostDeviceId 字段；guard；UI 提示 |
| **Out of scope** | 完整账号、转让 host UI（可第二卡）、密码 |
| **实现要点** | `GameState.hostDeviceId?: string`；首个带 deviceId 的 join 写入；handle 内 `if (!isHost(ws)) sendError`；host 断线仍保留 hostDeviceId（勿自动转移除非另卡） |
| **Done** | [ ] 非 host 敏感操作失败有中文错误 [ ] host 成功 [ ] UI 有提示 [ ] 测试覆盖 |
| **验证** | vitest + tsc |
| **窗口** | M；不要同时做 T17/T19 |

---

### T19 — 标准最小加注增量 `lastRaiseSize`

| | |
|--|--|
| **Goal** | 最小加注额 = 上一次有效加注增量；新街重置为 bigBlind |
| **Why** | 接近标准 NLHE（R3）；**仅当人类明确要求** |
| **Depends on** | 人类确认；建议 T07/T08 已完成以免联调乱 |
| **必读** | `handleAction` raise；`handleNextRound` 清零；`postBlinds`；前端 raise min |
| **可写** | `types`；`game-room`；`render.js`/`actions.js` 的 min；测试 |
| **In scope** | lastRaiseSize 状态机 + 前端 min 显示 |
| **Out of scope** | straddle；边池；host |
| **实现要点** | 开街 `lastRaiseSize = bigBlind`；完整加注成功后 `lastRaiseSize = raiseSize`；不足额 all-in 不提升 min（与现「不重开」一致）；publicState 下发 `minRaise` 供前端 |
| **Done** | [ ] 测：先加注 3BB 后再加至少 3BB [ ] 新街恢复 BB [ ] 前端 min 同步 |
| **验证** | vitest + tsc + 手测 |
| **窗口** | L；**单独会话，不做其它卡** |

---

### T20 — `serverVersion` 或 `buildId` 下发

| | |
|--|--|
| **Goal** | 客户端能知道后端版本，便于「该强刷了」 |
| **Why** | R7 可观测性 |
| **Depends on** | — |
| **必读** | `publicState`；`wrangler` 无内置则用常量 |
| **可写** | `types`；`game-room` 或 `index`；前端 conn 旁小字可选 |
| **In scope** | 常量 `BUILD_ID`（手动或 commit sha 剪短）打进 publicState |
| **Out of scope** | 自动强制刷新整页逻辑（可另卡） |
| **Done** | [ ] state 含字段 [ ] deploy 文档一句：改 BUILD_ID |
| **验证** | tsc |
| **窗口** | S |

---

### T21 — 业务提示与 `error` 通道分离

| | |
|--|--|
| **Goal** | `sendToAll` 的非失败提示用 `type:'notice'`；真错误仍 `error` |
| **Why** | 前端 toast 语义清晰 |
| **Depends on** | — |
| **必读** | 所有 `sendToAll` 调用点；`app.js` onMessage；types ServerMessage |
| **可写** | types；game-room；app.js toast 分支 |
| **In scope** | 枚举分流；前端同等 toast 即可 |
| **Out of scope** | i18n；日志系统 |
| **Done** | [ ] 类型含 notice [ ] 至少结算成功类提示不再标 error（按调用点理性划分） |
| **验证** | tsc；抽查调用点 |
| **窗口** | S–M |

---

### T22 — 可选入桌口令

| | |
|--|--|
| **Goal** | 建房时可设 joinPassword；join 校验 |
| **Why** | R6 轻量防护 |
| **Depends on** | 人类确认需要 |
| **必读** | POST `/api/rooms` body；`handleJoin`；前端 create/join 表单 |
| **可写** | index 路由 init；game-room；types；前端少量 |
| **In scope** | 明文口令存在 DO（熟人局可接受）；错误码中文 |
| **Out of scope** | 哈希升级、OAuth |
| **Done** | [ ] 错误口令不可进 [ ] 无口令房行为不变 |
| **验证** | 手测 + tsc |
| **窗口** | M |

---

### T23 — GitHub Actions：typecheck + test

| | |
|--|--|
| **Goal** | push/PR 自动跑 `tsc` 与 `vitest` |
| **Why** | R8 |
| **Depends on** | — |
| **必读** | `package.json` scripts；现有 vitest 配置 |
| **可写** | **仅** `.github/workflows/ci.yml`（新建） |
| **In scope** | node 版本与 npm ci；`npm run typecheck`；`npm test` |
| **Out of scope** | deploy；lint 新体系 |
| **实现要点** | `ubuntu-latest`；timeout 拉长（workers pool）；失败即红 |
| **Done** | [ ] workflow 文件存在 [ ] 本地 yaml 合理 [ ] 不强求本环境触发 GH |
| **验证** | 文件审阅 |
| **窗口** | S |

---

### T24 — deploy 脚本提示 cache bump

| | |
|--|--|
| **Goal** | `npm run deploy` 前 echo 检查清单（前端 ?v=、sw CACHE、后端无热更） |
| **Why** | R7 |
| **Depends on** | — |
| **必读** | `package.json`；`public/sw.js` 首行 CACHE；`index.html` ?v= |
| **可写** | `package.json` scripts；可选 `scripts/predeploy-check.mjs` 只打印不拦截 |
| **In scope** | 提示；可 `predeploy` 脚本 |
| **Out of scope** | 自动改版本号（易抢戏，另卡） |
| **Done** | [ ] `npm run deploy` 前可见提示 |
| **验证** | 跑 script dry |
| **窗口** | S |

---

### T25 — 两人桌摊牌简化 UI

| | |
|--|--|
| **Goal** | 仅 2 名 `!isFolded` 时：点一人即视为单档胜者，可直接确认；不展示「下一档」 |
| **Why** | 降认知负担；后端协议不变 |
| **Depends on** | —（与 T11 有 UI 交集：若 T11 未做，本卡独立；若已做，在预览流里分支） |
| **必读** | `render.js` `renderShowdown`；`actions.js` confirmTiers |
| **可写** | render.js；actions.js；styles 可选；bump cache |
| **In scope** | UI 分支 |
| **Out of scope** | 改 endHand 校验；边池算法 |
| **实现要点** | `const contesting = players.filter(p => !p.isFolded); if (contesting.length === 2) { /* 单击选中唯一 winner，隐藏 next-tier */ }` |
| **Done** | [ ] 2 人无下一档 [ ] ≥3 人仍分档 [ ] cache bump |
| **验证** | 手测 |
| **窗口** | S–M |

---

## 5. 明确不做（勿开任务卡）

| 事项 | 原因 |
|------|------|
| 断线改 fold | 破坏公平与不变量 |
| 单挑 postflop SB 先动 | 错规则 |
| React 重写前端 | 成本无匹配收益 |
| 自动算牌力 | 产品变体 |
| 为共享 3 个谓词上 monorepo | 过重 |
| 无测试大改 award/plan | 筹码守恒极脆 |

---

## 6. Agent 领取模板（复制即用）

```text
你只执行 poker-scorer 任务卡 Txx（见 docs/RISKS_AND_IMPROVEMENTS.md §4）。
遵守 §0 强制协议与全局禁改。
只读该卡「必读文件」，只改「可写文件」。
完成后按 Done 定义逐条汇报，并给出验证命令输出摘要。
不要开始任何其它 Task ID。
```

---

## 附录 A：风险展开（只读，不执行）

### A1 无权限
任何 WS 连接可 `endHand` / `updateSettings` / `rebuy` / `removePlayer`。熟人局可接受；误触与房号泄露是主因。缓解：T03–T06 确认链，可选 T18 host、T22 口令。

### A2 人手选胜
`awardPotsByTiers` 数学正确不保证名次正确。缓解：T09–T11 预览确认。

### A3 规则简化
最小加注固定 BB 等。文档说明；要标准规则走 T19 单卡。

### A4 毁房清理
`alarm`：waiting + 日切或 TTL → 删存储与 registry；手牌中 +15min。缓解：T16 展示；T17 soft reset（需产品决策）。

### A5 同源分叉
`isRoundComplete` 双份。缓解：T07–T08。

### A6 安全
CORS *、无登录。公开分享场景升 P1。T22/平台限流。

### A7 部署缓存
无热更；SW/`?v=`。T20/T24。

### A8 测试缺口
T12–T15、T23。

---

## 附录 B：文件热力图（帮 Agent 估窗口）

| 文件 | 约行数 | 说明 |
|------|--------|------|
| `src/game-room.ts` | ~1100 | 核心；能只读片段就不要全文 |
| `src/types.ts` | ~155 | 协议 |
| `public/scripts/render.js` | ~295 | UI 同源 |
| `public/scripts/actions.js` | ~175 | 发送 |
| `public/scripts/app.js` | ~300 | 粘合 |
| `test/game-room.test.ts` | ~840 | 测试任务主战场 |

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-18 | 初版风险与改进长文 |
| 2026-07-18 | 重构为 AI 200k 窗口可精确执行的任务卡（T01–T25）+ 强制协议 |
| 2026-07-19 | **T01 完成**：移除未使用的 hono 依赖，`npm uninstall hono`，tsc 通过 |
