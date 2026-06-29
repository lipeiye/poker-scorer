# 工作日志 (WORKLOG)

> 按时间倒序，最新在最上。给后续维护者（人或 AI）看的"发生过什么 + 为什么"记录。
> 项目导航与不变量请先看 [CLAUDE.md](./CLAUDE.md)。

---

## 2026-06-28 — 修"点弃牌完全无反应"

### 现象（用户反馈）
点弃牌按钮完全没反应、没提示，弃不掉。

### 根因（纯前端 bug，与状态/部署版本无关）
`actions.js` 的 `onFoldClick()` 用 `$('#btn-fold')`（**按 id 查找**）找弃牌按钮。但弃牌按钮由 `render.js` 的 `renderActionBar` 用 `data-action="fold"` 渲染——**根本不存在 `id="btn-fold"` 的元素**。于是 `$('#btn-fold')` 恒为 `null`，`if (!btn) return` 直接静默返回，弃牌请求从未发出。整个项目里搜不到 `id="btn-fold"`，只有 actions.js 在找它。

教训：事件委托体系下按钮没有固定 id，二次确认逻辑必须用事件委托传入的按钮元素，不能按 id 找。

### 改动
- `public/scripts/actions.js`：`onFoldClick(btn)` 改为接收 app.js 事件委托传入的按钮元素；武装态用元素引用（`foldArmed`）而非布尔；`resetFold` 用 `isConnected` 判断节点是否仍在文档中再恢复文字/class。删除按 id 查找。
- `public/scripts/app.js`：事件委托 `case 'fold': onFoldClick(btn)` 传入被点击按钮。
- 缓存戳 `?v=5 → ?v=6`、SW `pk-shell-v5 → pk-shell-v6`。

### 验证
- 后端弃牌逻辑经 vitest 实测正常（turn 首动者弃牌成功、无报错），本 bug 纯前端。
- 部署 Version ID `5d4d55ad-10c6-476d-9eb0-a6b01bac9758`。需强制刷新拿新前端（v6）。

### 期间误判记录（避免重蹈）
曾先后怀疑：①心跳保活、②sittingOut 状态、③旧前端缓存、④回合解耦。后端测试一一排除（回合解耦正确、turn 弃牌成功）。最终定位到是前端按钮查找 bug——"完全没反应/没提示"本应第一时间指向"事件没触发/没发出"，而非"状态逻辑"。下次遇到"点了无反应"先查前端事件链路。

---

## 2026-06-27 (晚) — 修"断线导致盲注位次下移、SB/BB 塌缩到一人、一人直接独胜"

### 现象（用户反馈）
玩家断线后：盲注位次（SB/BB/Dealer）会顺着活跃环"往下延续"，最终小盲、大盲压到同一个人身上，那个人直接赢；位次在本轮内不稳定。

### 根因
`markDisconnected` 断线即 `isActive=false` + `isFolded=true`。整个位次/盲注/轮转系统建立在单一"活跃环"（`isActive` 过滤 + `nextActiveIndex`）之上——fold / all-in / 断线都会**收缩这个环**。于是：
- 座位与盲注位次顺着活跃环往下延续（环收缩）；
- `handleAction` 的"仅剩一人未弃牌即独胜"判定（`!isFolded && isActive`）在断线导致活跃人数降到 1 时**直接判一人赢**。

### 改动：把"桌面位次（本手牌固定）"与"能否参与争夺（fold 才退出）"解耦
新增 `Player.isSittingOut`（占座但不行动、不付筹码）。断线者保持座位、盲注归属与底池权益，仅"纯跳过"。

- `src/types.ts`：`Player` 加 `isSittingOut: boolean`。
- `src/game-room.ts`：
  - **`markDisconnected`**：手牌进行中断线改为 `isSittingOut=true`，**不再** `isActive=false` / `isFolded=true`；若是当前行动者则 `advanceTurn` 跳过他。
  - **可行动谓词统一加 `!isSittingOut`**：`advanceTurn` / `isRoundComplete` / `setFirstToAct`。挂机者既不会被选为当前行动者，也不会因"全员已行动"误判本轮完成；轮到他时由 advanceTurn 自动纯跳过（无筹码变动）。
  - **获胜判定收紧**：`handleAction` 的"剩余争夺者"过滤改为 `!p.isFolded`（断线挂机者未弃牌、仍争夺，不计入"被淘汰"），杜绝"一人断线→另一人直接赢"。
  - **`handleStartHand`** 每手重置加 `p.isSittingOut = !p.isConnected`：下一手开始时在线者清除挂机、离线者继续占座挂机。位次/盲注环继续基于 `isActive`（开手牌时按在线快照固定），断线不收缩环 = 位次在本手牌内固定不变。
  - **重连 `handleJoin`**：手牌进行中重连保持 `isSittingOut=true`（本手牌仍挂机）；仅 `round==='waiting'` 时重连才清除挂机、复活 `isActive`。符合需求"重连者等下一轮发牌才参与"。
  - 新玩家字面量补 `isSittingOut: false`。
- `public/scripts/render.js`：前后端同源逻辑同步——`isRoundComplete`、`renderShowdown`（候选获胜者）、`isTurn` 判定均加 `!isSittingOut`；挂机玩家显示「暂离」标签。
- 缓存戳 `?v=4 → ?v=5`、SW `pk-shell-v4 → pk-shell-v5`。

### 验证
- `npx vitest run`：**22 项全通过**。改写 ROOM06 断线用例（断线者保持 isActive、转 isSittingOut、不 fold、不提前判胜）；新增 3 个用例：①轮到挂机者纯跳过（筹码/下注不变、行动权转给下一位）②断线不让人提前独胜（即便只剩一个未断线者）③手牌中重连仍挂机、下一手发牌才复活。

### 部署
- 需 Node v22+（已就绪）。后端改动必须 `npx wrangler deploy` 才生效。

---

## 2026-06-27 — 修"持久连接太短 + 并发重连导致大忙/小忙集中到一人"

### 现象（用户反馈）
- 暂时退出浏览器再回来，WebSocket 持久连接已断、重连连不上。
- 多个用户同时退出后并发重连时，盲注错位：大盲、小盲都压到同一个人身上。

### 澄清
- **不是 TCP 握手超时**。Cloudflare Workers 的 WebSocket 在应用层没有可调的 TCP 握手时钟。真凶是心跳/重连节奏 + DO 并发收敛竞态。

### 改动
1. **前端保活窗口拉到 ~5 分钟**（`public/scripts/socket.js`）：
   - `PING_INTERVAL 15s → 60s`；`PONG_TIMEOUT 10s → 240s`。
   - 原节奏下移动端切后台（浏览器节流定时器+网络栈）10s 收不到 pong 就主动 `ws.close()` → 重连风暴，表现为"持久连接太短"。
   - `visibilitychange` 切回前台时：连接还在就补发 ping 立即校验，已断则立即重连（原逻辑只处理"已断"）。
2. **并发重连收敛竞态修复**（`src/game-room.ts` `handleJoin`）：
   - 原来先关旧 socket、后注册新连接。DO 的 `webSocketClose` 异步串行，若在 `connections.set(ws,...)` 之前触发，`hasAnotherConnection` 为 false → 刚重连的玩家被误判离线、游戏中被 fold。
   - 改为**先注册新连接、再关旧连接**，保证 close 回调里一定能看到新连接。
3. **盲注 SB≠BB 防御**（`src/game-room.ts` `postBlinds` + 新增 `nextDifferentActiveIndex`）：
   - 并发重连曾让 `isActive` 状态瞬时错乱，`nextActiveIndex(dealerIndex)` 与 `nextActiveIndex(sbIdx)` 可能返回同一玩家 → SB/BB 集中到一人。
   - 显式校验 `bbIdx !== sbIdx`，异常时用 `nextDifferentActiveIndex` 兜底；仍无法区分则放弃盲注（保护性 return）。
4. **缓存戳升级**：前端脚本 `?v=3 → ?v=4`；SW 缓存 `pk-shell-v3 → pk-shell-v4`（styles.css 也对齐 `?v=4`），确保新代码分发。

### 验证
- `npx vitest run`：19 项全通过（含新增「盲注 SB≠BB」「重复 join 不判离线」两个用例）。
- `tsc`：本沙箱缺 `@cloudflare/workers-types`，纯 `tsc` 报的全是 pre-existing 的 Cloudflare 命名空间/全局类型缺失，与本次改动无关。

### ⚠️ 待部署
- 后端改动**必须 `npx wrangler deploy` 才生效**（无热更新）。本机 Node v20 不满足 wrangler 要求的 v22+，**部署未执行**。需在 Node v22+ 环境跑 `npx wrangler deploy`，记下 Version ID。
- 部署后建议进行中房间刷新重连，下一手牌起按新代码计算盲注。

---

## 2026-06-20 — 行动顺序"误报 bug" + 误改 + 回退；并清理撑爆磁盘的 stray .git

### 起因
用户报告："每一轮翻牌之后的行动顺序反了，应该永远小盲先操作。"

### 调查结论（重要）
- 前端 `public/index.html` 是**瘦客户端**：行动顺序完全由后端 `currentPlayerIndex` 决定，前端只渲染。顺序逻辑只在 `src/game-room.ts` 的 `setFirstToAct()`。
- 用独立 Node 模拟（`/tmp` 下，不依赖 vitest）忠实复刻算法验证：**3+ 人时翻牌后本就是小盲先动（正确）**；翻牌前 UTG 先动（正确）。
- 对齐时间戳发现：线上最后部署（07:46Z）在源码最后修改（07:41Z）**之后**，即线上跑的就是这份"已正确"的代码。
- 唯一能同时解释"代码正确"又"用户看到反了"的情形：**用户在用 2 人单挑测试**。单挑时翻牌前小盲(=庄家)先动、翻牌后大盲先动——视觉上像"翻转"。

### 误改（已回退，勿重蹈）
据用户"永远小盲先操作"的字面要求，曾把 `setFirstToAct` 改成"翻牌后无论人数都小盲先动"，部署为版本 `05d159e1`。

### 回退
用户得知"**单挑翻牌后大盲先动本就是德州标准规则**"后要求恢复。已：
- 将 `setFirstToAct()` 还原为原始标准实现。
- 删除当时新增的 ROOM13 单测（断言的是错误预期）。
- 重新部署为版本 **`f861340b`**（= 行为等同会话前的 `5ec373e6`，标准规则）。
- 模拟 + `tsc` 复核通过。

➡️ **教训：单挑(2人)翻牌后由大盲先行动是正确的，不是 bug，不要再"修"。** 详见 [CLAUDE.md](./CLAUDE.md) 的"扑克行动顺序不变量"。

### 期间事故：磁盘 100% 撑爆（已处理）
- 现象：写文件全部 `ENOSPC`，连 1 字节都写不进，回退/部署被卡死。
- 根因：**卷根误建的 git 仓库** `/Volumes/2chuiniu/.git`（跟踪了整卷、无任何 commit），某次对超大文件跑 `git add/gc` 撑爆磁盘后，在 `.git/objects/pack/` 残留了一批孤儿临时打包文件：`tmp_pack_hMwnaR` 335G、`tmp_pack_BKAU4P` 89G、`tmp_pack_HkJf2m` 26G 等，合计 ~465G；另有 ~63G 松散对象。
- 处理（经用户选择"删整个卷根 .git"）：
  1. 先删孤儿 `tmp_pack_*`/`tmp_idx_*`（崩溃残骸，纯垃圾）→ 释放 ~465G。
  2. 把索引里仅有的 6 个 student-api Java 文件（状态 `AD`：已暂存但工作区已删）抢救到 **`/Volumes/2chuiniu/_recovered-git/`**。
  3. `rm -rf /Volumes/2chuiniu/.git`。
- 结果：磁盘回到 ~44% 已用、剩 ~529G。
- ⚠️ 后续：若仍需对这些资料做版本管理，请在**具体子项目目录内**单独 `git init`，**不要在卷根 `/Volumes/2chuiniu` init**（会把整卷包括大文件/备份一起跟踪，必然再次撑爆）。

### 线上现状
- URL：https://poker-scorer.1956133426lpy.workers.dev
- 当前版本：`f861340b-d51c-40d6-8c39-2d5ab3d9f5e0`（标准规则）
- 让用户感知：后端改动须重新部署才生效；进行中的一手牌不会回填，**下一手牌 / 下一轮**起按新代码计算；建议刷新页面重连。
