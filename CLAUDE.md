# CLAUDE.md — poker-scorer 导航（给 AI agent）

> 本文件由 Claude Code 每次会话自动载入。目的：让你**不用重新探索**就能动手，省 token、提缓存命中。
> 维护原则见文末"为什么这份文件存在"。结构性事实放这里；时效性记录写 [WORKLOG.md](./WORKLOG.md)。

## 是什么
实时德州扑克**计分器**（不发牌，只记筹码 / 盲注 / 行动轮转），部署在 Cloudflare Workers Free Tier。

## 架构（一句话）
单个 Worker：静态前端走 Static Assets；`/api/rooms/:id/*` 与 `/ws/:id` 路由到「每房间一个 SQLite-backed Durable Object `GameRoom`」——房内操作串行、房间间横向扩展；WebSocket 用 Hibernation API，玩家身份存在 socket attachment。

## 关键文件（认函数名，行号仅提示）
- `src/game-room.ts` — 全部游戏逻辑(DO)。热点：`setFirstToAct()`（行动起点·最易改错）、`advanceTurn()`、`postBlinds()`、`handleNextRound()`、`handleAction()`、`isRoundComplete()`、`nextActiveIndex()`。
- `src/index.ts` — 路由。房号正则 `/^\/api\/rooms\/([A-Z2-9]{6})/`（**排除 0/1**）。
- `src/types.ts` — 类型与常量（默认盲注、`getRoundName`）。
- `public/index.html` — **瘦客户端**，只渲染后端 `currentPlayerIndex`，**不含顺序逻辑**。
- `test/game-room.test.ts` — vitest（Cloudflare workers pool）。

## 扑克行动顺序不变量（动手前必读）
座位：`position` 0=庄家D / 1=小盲SB / 2=大盲BB / 3=UTG…；`dealerIndex` 是 players 数组下标；"下家"= `nextActiveIndex`（索引递增方向）。
- 盲注：SB=庄家下家，BB=SB下家。**单挑例外：庄家即 SB**。
- **翻牌前**首动 = UTG（BB 下家）；单挑 = SB(=庄家)。
- **翻牌后 (flop/turn/river)** 首动 = SB；单挑 = BB（庄家/SB 在位、最后动）。
- ⚠️ **单挑翻牌后"大盲先动"是标准规则、不是 bug。** 曾被误当 bug 改成"永远小盲先动"又回退——别再犯。见 [WORKLOG.md](./WORKLOG.md) 2026-06-20。

## 任务手册（用这些固定命令，利于缓存）
- **验证顺序逻辑**：别只靠 `npm test`——本沙箱里 Cloudflare vitest pool 启动常 90s 超时。最稳：把 `setFirstToAct/advanceTurn/postBlinds/nextActiveIndex` 原样抄进一个纯 Node `.mjs` 跑 2/3/4 人模拟（见 WORKLOG 做法）。
- 类型检查：`npx tsc --noEmit`
- **部署（任何后端改动都必须；无热更新）**：`npx wrangler deploy` → 记 `Current Version ID`。
- 线上日志：`npx wrangler tail`
- 线上自测：`POST /api/rooms`（房号由 `generateRoomCode` 生成，必合法）→ 查 `/api/rooms/<id>/state`。自造非法房号（含 0/1）会落到 ASSETS 报 1101，属正常、非故障。

## 易踩的坑
- 后端改动**只能靠重新部署生效**；DO 房间状态跨部署保留，进行中的一手牌不回填，**下一手 / 下一轮**才走新代码。
- `wrangler.toml` 必须保持 `new_sqlite_classes = ["GameRoom"]`（Free Tier 只支持 SQLite-backed DO；改回 `new_classes` 会坏）。
- **绝不在卷根 `/Volumes/2chuiniu` 跑 `git init/add`**——会把整卷大文件/备份一起跟踪，曾撑爆磁盘到 100%。要版本管理就在本项目目录内单独 `git init`。
- `wrangler deploy` 在非 TTY 后台运行时，输出会缓冲到结束才出现，别误判为卡死。

## 为什么这份文件存在
Claude Code 每次会话开始就把本文件载入上下文，所以你能跳过"读一堆文件重新搞懂架构 / 找热点 / 推断扑克规则"的过程——直接省下大量 Read·Grep·Bash 的 token。它同时改善**提示缓存命中**：作为稳定前缀被缓存、会话内（及相邻会话）复用；你探索越少、命令越固定，上下文增长越慢，被缓存的前缀越能持续命中。请**保持它稳定、精炼、最新**，别每次会话大改（大改会使缓存前缀失配）。
