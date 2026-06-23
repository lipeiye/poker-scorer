# 移动端视觉测试报告

> 生成时间：2026-06-22  
> 测试对象：`public/index.html`（德州扑克计分器前端）  
> 测试方式：本地静态服务 + Playwright 多视口截图

---

## 1. 测试目的

在不部署、不改动源码的前提下，对项目在手机端的视觉效果进行可复现、可量化的快速验证。重点检查：

- 小屏到主流大屏手机的布局适配
- 各核心视图（首页、大厅、牌局、弹窗）的视觉完整性
- 操作栏、按钮、文字在窄屏下的可读性
- 身份标记（庄家 D、小盲 SB、大盲 BB、当前回合高亮、你自己）的呈现

---

## 2. 测试环境

| 项目 | 说明 |
|------|------|
| 操作系统 | macOS |
| 浏览器 | Playwright Chromium 149.0.7827.55 |
| 服务方式 | Node.js 内置 `http` 模块从 `public/` 目录提供静态文件 |
| 测试脚本 | 临时目录内编写，测试后已删除 |
| 状态注入 | 通过 `page.evaluate()` 直接设置前端 `state` 与 `myPlayerId`，模拟真实牌局 |

---

## 3. 测试视口

| 名称 | 逻辑分辨率 | DPR | 代表机型 |
|------|-----------|-----|----------|
| small | 320 × 568 | 2 | 旧款小屏手机 |
| android-small | 360 × 640 | 2 | 安卓入门机 |
| iphone-se | 375 × 667 | 2 | iPhone SE |
| iphone-14 | 390 × 844 | 3 | iPhone 14 |
| iphone-14-pro-max | 430 × 932 | 3 | iPhone 14 Pro Max |

---

## 4. 测试场景

每个视口下均截取 8 个关键状态：

1. **01-home**：首页默认状态
2. **02-name-modal**：创建房间时的名字输入弹窗
3. **03-share-modal**：房间创建后的分享弹窗
4. **04-lobby**：大厅等待（含排行榜、玩家列表、盲注设置、开始游戏按钮）
5. **05-game-preflop-myturn**：翻牌前，轮到自己操作，显示底部操作栏
6. **06-game-flop-waiting**：翻牌后，等待他人操作，操作栏隐藏
7. **07-game-showdown**：摊牌阶段，显示获胜者选择按钮
8. **08-winner-modal**：本手获胜祝贺弹窗

---

## 5. 测试通过项

### 5.1 布局适配

- 在 320px ~ 430px 范围内，所有页面均未出现横向滚动或内容溢出。
- `home-shell`、`content-shell`、`game-hero` 等容器使用 `max-width` + 百分比宽度，居中良好。
- 大厅与牌局的 `leaderboard`、`player-list` 在小屏下为单列，适配自然。

### 5.2 顶部栏

- 房间码 `PKAB12` 使用大间距字母，辨识度好。
- 返回按钮、在线人数、复制按钮在 320px 下未换行或重叠。

### 5.3 底池与公共牌

- 底池金额 `150`、`220`、`420` 使用 `42px` 大字号，在各种尺寸下均清晰可读。
- 公共牌占位符与已发牌样式对比明显，翻牌/转牌/河牌状态易于区分。

### 5.4 玩家卡片

- 身份标记（D / SB / BB / ALL / 离线）以彩色小标签呈现，不挤压姓名。
- 当前回合高亮（金色边框 + 脉冲动画）在深色背景下醒目。
- “你自己”的绿色头像边框与 “你” 标签正确显示。
- 弃牌玩家以 `opacity: 0.38` + `saturate(0.5)` 正确置灰。

### 5.5 底部操作栏

- 轮到玩家时，操作栏固定在底部，按钮布局为 `flex-wrap`。
- 在 320px 极小屏上，三个按钮（弃牌 / 跟注 20 / 加注）仍可完整显示，文字未截断。

### 5.6 弹窗

- 名字弹窗输入框获得焦点时绿色边框清晰。
- 分享弹窗的房间码 `PKAB12` 字号足够大，复制/分享按钮并排显示正常。
- 弹窗均使用 `max-width: 390px`，在大屏手机上保持合适比例。

---

## 6. 发现的问题

### 6.1 赢家弹窗标题在小屏换行不自然（轻微）

**现象**：在 320px 视口下，赢家弹窗标题：

```
恭喜你拿下这一
手！
```

“手！” 单独留在第二行，视觉上略显突兀。

**建议**：

- 方案 A：在小屏断点（`@media (max-width: 380px)`）下将 `.winner-modal h2` 的字号从 `27px` 降至 `23px` 左右。
- 方案 B：为标题添加 `word-break: keep-all` 或 `white-space: nowrap`，让整行一起换行，再由容器内边距保证不溢出。

---

## 7. 可进一步验证的方向

本次测试以静态截图为主，未覆盖以下动态/交互场景，如需更全面可后续补充：

- 加注输入框展开后的底部操作栏高度与页面滚动
- 8~9 人长列表下的滚动与固定顶部栏表现
- 真实键盘弹起对输入框/操作栏的遮挡
- 横屏（landscape）模式
- 不同字体的真实渲染差异

---

## 8. 测试脚本关键逻辑（备查）

```js
// 视口定义
const viewports = [
  { name: 'small', width: 320, height: 568, dpr: 2 },
  { name: 'android-small', width: 360, height: 640, dpr: 2 },
  { name: 'iphone-se', width: 375, height: 667, dpr: 2 },
  { name: 'iphone-14', width: 390, height: 844, dpr: 3 },
  { name: 'iphone-14-pro-max', width: 430, height: 932, dpr: 3 },
];

// 状态注入示例（翻牌前轮到自己）
state = {
  roomId: 'PKAB12',
  handNumber: 1,
  round: 'preflop',
  communityCards: 0,
  pot: 150,
  currentBet: 20,
  dealerIndex: 2,
  currentPlayerIndex: 0,
  lastAction: 'Bob 下注 20',
  players: [ /* ... */ ],
};
myPlayerId = 'dev-001'; // 让自己对应 Alice
render();
```

---

## 10. 后续修复记录（2026-06-22 追加）

### 10.1 问题背景

用户在实际手机测试时反馈：

1. **开始游戏后缺少操作按钮**：看不到“加注”“下一轮”等按钮。
2. **切出浏览器后立刻要求重连**：重连过程可能失败，导致无法继续操作。

### 10.2 根因分析

- **按钮消失与重连强相关**：游戏进行中若 WebSocket 断开，操作栏会隐藏且无法收到新的 `state` 消息，因此按钮不渲染。根因是移动端切后台/锁屏后连接被关闭，且**原来的 `beforeunload → disconnect()` 会把切后台误判为“用户主动离开”**，设置 `intentionalClose = true`，导致切回前台后不再自动重连。
- **重连不及时**：原重连只有固定 3 秒定时器，在后台会被浏览器节流；没有心跳保活，也无法检测静默断线。

### 10.3 改动内容

| 文件 | 改动 |
|------|------|
| `public/scripts/socket.js` | **心跳保活**：15s ping / 10s pong 超时；**指数退避重连**：2s → 4s → 8s … 最大 30s；**页面可见性监听**：切回前台 / 从 bfcache 恢复时立即重连；提供 `reconnectNow()` 接口 |
| `public/scripts/app.js` | 移除 `beforeunload → disconnect()`；改为 `pagehide` 仅在 `persisted === false`（真正关闭/导航）时才断开；大厅/游戏中的重连提示更合理 |

### 10.4 架构与解耦说明

- `socket.js` 继续作为**唯一连接生命周期管理者**：建连、重连、心跳、可见性恢复全部收敛在该模块。
- `app.js` 作为**协调者**：只决定“什么时候该断开”（用户点击离开 / 页面真正关闭），不再关心重连细节。
- `render.js` / `actions.js` / `ui.js` 完全无感知，符合原有分层。

### 10.5 部署信息

- **URL**: `https://poker-scorer.1956133426lpy.workers.dev`
- **Version ID**: `ef8fba08-d4c0-4c5e-9c5e-100caf19fc46`

### 10.6 线上回归问题与修复

**问题**：上线后发现“创建新牌局后无法进入房间”。

**根因**：`socket.js` 的 `persistIdentity()` 函数内部调用了 `savePlayer()`，但 `savePlayer` 未从 `./storage.js` 导入。`onState` 收到服务端状态后调用 `persistIdentity` 时抛出 `savePlayer is not defined`，导致后续 `render()` 与 `renderActionBar()` 没有执行，页面停留在首页，分享弹窗也无法出现。

**修复**：`import { deviceId, getSavedPlayer, savePlayer } from './storage.js';`

**验证**：使用 Playwright 在远端真实环境复现并确认无控制台报错，创建房间后正确进入大厅并显示“房间已创建”弹窗。

**修复后部署**：
- **Version ID**: `bc7e505f-8485-4115-b0ca-8a68eb38810f`

### 10.7 再次回归：游戏界面无法继续操作

**问题**：进入游戏界面后，轮到玩家时底部没有“弃牌 / 跟注 / 加注 / 下一轮”等操作按钮，无法继续游戏。

**根因**：前端拆分为模块时，`styles.css` 丢失了 `.action-bar.visible` 规则。`renderActionBar()` 会在需要时给 `#action-bar` 添加 `visible` 类，但 CSS 中仅有 `.action-bar { display: none; }`，没有对应的 `.action-bar.visible { display: flex; }`，导致操作栏始终不可见。

**修复**：在 `.action-bar` 规则后补回：

```css
.action-bar.visible{display:flex;animation:view-in .22s ease-out}
```

**验证**：使用两个独立 Browser Context（模拟两台手机）进行端到端测试：
1. Host 创建房间，Guest 加入
2. Host 点击“开始游戏”
3. Host 看到操作栏（弃牌/跟注/加注）
4. Host 点击“跟注”后，Guest 的操作栏自动出现

游戏流程恢复可继续。

**修复后部署**：
- **Version ID**: `66c7ada5-8372-4c96-b56f-9ac18f5acf2a`

### 10.8 清理声明

各次测试的临时目录 `mobile-test-tmp/`（含 Playwright、Chromium、截图、脚本）及本地服务进程均已清除。本报告为唯一保留的测试产物。
