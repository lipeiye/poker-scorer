# 方案 B · 逐步实施清单

> 顺序执行，每步都可独立验证。打勾再进下一步。

---

## Phase 0 · 准备

- [ ] 读 `idea/README.md`、`design-tokens.md`、`backend-protocol.md`、`plan-b-architecture.md`。
- [ ] 在 `poker-scorer/` 根目录找用户下载的 **Claude Design 导出文件**（.html/.tsx/.zip），
      解压整理，清点有哪些组件可用。
- [ ] 根目录 `npm install && npm run dev` 确认旧版能跑（基线对照，截图留存）。

---

## Phase 1 · 搭前端工程骨架

- [ ] `poker-scorer/web/` 下初始化 Vite + React + TS：
      `npm create vite@latest web -- --template react-ts`
- [ ] 装依赖（见 `plan-b-architecture.md` §2.4）：tailwind / clsx / tailwind-merge / lucide-react / framer-motion。
- [ ] 配 Tailwind：把 `design-tokens.md` 的颜色/圆角/阴影注入 `tailwind.config.ts` 的 `theme.extend`。
- [ ] `web/vite.config.ts`：`build.outDir='../public'`、`emptyOutDir=true`，并加 `/api` `/ws` 代理（见架构文档 §3）。
- [ ] 初始化 shadcn/ui（`npx shadcn@latest init`），按需 add：button / input / dialog / label / slider。
- [ ] **复制协议类型**：把 `src/types.ts` 里的 `PublicGameState` / `Player` / `Round` / `Action`
      / `ClientMessage` / `ServerMessage` / 默认常量复制到 `web/src/types.ts`。
- [ ] 写 `web/src/hooks/useGameSocket.ts`（参考 `backend-protocol.md` §3、§4 的语义）。
- [ ] 验证：`cd web && npm run dev`，用一个临时页面打印 `useGameSocket` 连上真实后端后的 state（控制台能看到）。

> ⚠️ Phase 1 完成前不要碰 Claude Design 组件，先保证数据通道通。

---

## Phase 2 · 移植 Claude Design 组件（按优先级）

每个组件都走：粘入 → 接 `useGameSocket` → 校验 token → 本地验证。

### 2.1 基础壳（先有可点的页面）
- [ ] `HomeScreen.tsx`：标题"PK"(serif) + 创建房间按钮 + 房间码输入 + 加入按钮。
      创建房间 → `POST /api/rooms` → 拿 roomId → 进 lobby。
      替代旧的 `prompt()` 取名字，用真正的输入框 + 一个名字输入。
- [ ] `Toast.tsx`：替代 `alert`/`prompt`，订阅 hook 的 error。

### 2.2 大厅
- [ ] `Lobby.tsx`：玩家列表 + 盲注设置（`updateSettings`）+ 开始按钮（仅自己已在房间时显示）。
- [ ] `PlayerCard.tsx`（大厅版，简化）：名字 + 筹码 + "你"标记。

### 2.3 游戏主界面（重点）
- [ ] `TopBar.tsx`：房间码（serif 大、accent 色）+ 手数。
- [ ] `RoundBadge.tsx`：轮次 pill。
- [ ] `CommunityCards.tsx`：5 个卡槽，按 `communityCards` 数量点亮。
- [ ] `PotDisplay.tsx`：底池，serif 大数字 accent 色。
- [ ] `PlayerCard.tsx`（游戏版，**全状态变体**）：参考 `design-tokens.md` §4.3，
      实现 轮到ta / 是我 / D / SB / BB / ALL / 弃牌 七种变体。
      位置标签前端推算（见 `backend-protocol.md` §3 末尾）。
- [ ] `GameTable.tsx`：把上面这些组合，列表渲染玩家。

### 2.4 操作栏（体验最糙，重做重点）
- [ ] `ActionBar.tsx`：fixed 底部，根据状态切换三种模式：
      - 轮到我 → 弃牌 / 过牌|跟注 / 加注
      - 本轮结束 → 单个"下一轮"按钮
      - 摊牌 → `ShowdownPicker`
- [ ] `RaiseControl.tsx`：− [输入] + 步进（步长 = bigBlind），上限 = 我的 chips。
- [ ] `ShowdownPicker.tsx`：列出未弃牌玩家多选 + 确认 → `endHand`。

### 2.5 收尾
- [ ] 动效：玩家列表 `staggerChildren` 淡入；状态变化用 `layout` 动画。
- [ ] 全局键盘聚焦态可见（`design-tokens.md` §5.4）。
- [ ] 移动端 safe-area、单栏、操作栏 fixed 复查。

---

## Phase 3 · 构建与部署验证

- [ ] `cd web && npm run build`：确认产物进了 `poker-scorer/public/`。
- [ ] 根目录 `npm run check`：typecheck + test + deploy --dry-run 全绿。
- [ ] 根目录 `npm run dev`（wrangler，serve 构建后的 public）：浏览器开 8787 全流程走一遍：
      创建房间 → 另一个浏览器/隐身窗口加入 → 开始 → 各操作 → 摊牌选获胜者 → 下一手。
- [ ] 两台真实手机同时操作（WebSocket 多端同步才是真验证）。
- [ ] 断网重连测试：游戏中关 WiFi，确认 3 秒重连并恢复身份。
- [ ] `npm run deploy`。

---

## 常见坑

| 现象 | 原因 / 解法 |
|---|---|
| `ws://` 在 https 页面被拦 | 生产是 `wss://`，按 `location.protocol` 判断（旧代码已有） |
| 重连死循环 | 仅在 `state.round !== 'waiting'` 时重连（旧代码已正确） |
| Claude Design 组件用了冷蓝/纯黑 | 没遵守 token，按 `design-tokens.md` 强制纠正 |
| 构建后 8787 白屏 | `emptyOutDir` 没清干净 / `base` 路径问题，检查 public 内容 |
| 位置标签算错 | 单挑(heads-up)时 SB=Dealer，多人时 SB=Dealer 下家，照搬旧实现 |
| `lobby-count` 显示 /10 | 协议上限是 12，按 `players.length` 动态显示即可 |
