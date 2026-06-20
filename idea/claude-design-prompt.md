# 喂给 Claude Design 的完整提示词

> 把下面的内容**整段复制**到 Claude Design（claude.ai → Labs → Claude Design）里。
> 已按本项目实际协议与设计 token 定制，生成的是 React + Tailwind + shadcn/ui 组件，
> 可直接粘进 `web/src/game/`。

---

## 全局开场提示（第一次对话，定基调 + 定 token）

```
我要重新设计一个「德州扑克实时计分器」网页的全部组件。这是协作的起点，请先记住以下设计系统，后续所有组件都必须严格遵守。

【产品】
多人通过 6 位房间码加入同一房间，WebSocket 实时同步。每人轮流操作（弃牌/过牌/跟注/加注），到最后手动选获胜者分底池。手机上多人同时使用，移动端优先。

【调性】像 claude.ai：奶油色背景、衬线大标题、克制暖色、圆角、低对比、有人文编辑感。不要纯黑、不要霓虹、不要 Material 阴影。

【设计 Token —— 所有组件必须用这套】
配色：
  背景奶油 #FAF9F5 / 次级面板 #F0EEE6 / 凹陷输入底 #ECE9DE / 深色侧栏 #262624
  文字 #1A1A1A / 次要 #5E5D58 / 弱 #8B8A82 / 深底反白 #FAF9F5
  边框 暖灰 #E5E2D9 / 强 #D4D1C5
  强调珊瑚橘 #D97757 / hover #C15F3C / 弱底 #F5E6DE
  状态 success #5E8C6A / warning #C4925A / danger #B5564F
字体：
  标题用衬线 "Fraunces"/"Newsreader"/Georgia，字重 500，letter-spacing -0.02em
  正文 "Inter"/-apple-system/"PingFang SC"，行高 1.6-1.7
形状：圆角 sm 8 / md 12 / lg 16 / pill 999
阴影（要软、暖、低透明，少用）：0 4px 16px rgba(48,45,36,.06)
动效：cubic-bezier(.22,1,.36,1)，时长 150-250ms，不要弹跳
间距：全部 4 的倍数，区块间 ≥ 32px

【约束】
- 技术栈固定：React 18 + TypeScript + Tailwind + shadcn/ui + lucide-react
- 移动端优先，单栏；桌面端居中限宽 480px
- 少用阴影，多用 1px 暖色边框 + 浅色背景层级区分区块
- 聚焦态永远可见：2px accent 实线 + 2px 白色外环

收到后请回复确认，然后我会逐个让你做组件。
```

---

## 逐组件提示词（按 implementation-steps.md 的顺序逐个发）

每个组件提示词结构相同：**职责 → 数据来源（state 字段）→ 视觉规范 → 交互（发什么消息）**。
组件里用到的数据都从一个 `state: PublicGameState` prop 传入，动作通过 `send(msg)` 回调发出。

> 先把下面这段"数据契约"也贴给 Claude Design，让它知道 state 长什么样：

```
【数据契约 —— 所有组件的 state 来源】
interface PublicGameState {
  roomId: string;
  players: Player[];
  round: 'waiting'|'preflop'|'flop'|'turn'|'river'|'showdown';
  pot: number;
  currentBet: number;
  dealerIndex: number;
  currentPlayerIndex: number;
  smallBlind: number;
  bigBlind: number;
  handNumber: number;
  lastAction: string;
  communityCards: number;   // 0/3/4/5
}
interface Player {
  id, name, chips, position,
  isFolded, isActive, isAllIn,
  currentBet, totalBet, hasActedThisRound, isConnected
}
【消息回调】组件通过 send(msg) 发送：
  {type:'action', action:'fold'|'check'|'call'|'raise', amount?}
  {type:'startHand'}  {type:'nextRound'}
  {type:'endHand', winnerIds:string[]}  {type:'updateSettings', settings:{smallBlind?,bigBlind?}}
```

---

### 组件 1 · HomeScreen（首页）
```
做首页组件 HomeScreen。
- 大标题 "PK"，serif，48-64px，字重500，letter-spacing 收紧，"K" 用 accent 珊瑚橘。
- 居中卡片：名字输入框（凹陷底 #ECE9DE，聚焦 accent 边框+光晕）。
- 主按钮"创建房间"（accent 实心）+ 次级按钮"加入房间"，下面跟一个 6 位房间码输入（letter-spacing 4px，大写）。
- 加入前先校验房间码 6 位。创建/加入都先取名字。
- 创建房间会由父组件调 POST /api/rooms，组件只需 onSubmit(name) 和 onJoin(name, code)。
移动端单栏，按钮高 52px。
```

### 组件 2 · Lobby（大厅）
```
做大厅组件 Lobby，props: { state, myPlayerId, send }。
- TopBar：房间码（serif 大、accent 色、letter-spacing 2px）左，玩家数右。
- 玩家列表：每项一张卡（面板底+1px暖边框），显示名字 + 筹码(accent 色)，是我自己加 accent 边框。
- 盲注设置两行（小盲/大盲数字输入），改完 send({type:'updateSettings', settings})。
- 底部固定"开始游戏"主按钮（仅当我在 players 里才显示），点击 send({type:'startHand'})。
```

### 组件 3 · PlayerCard（游戏版，最关键）
```
做玩家卡组件 PlayerCard，props: { player, isMe, isCurrentTurn, isDealer, isSB, isBB }。
视觉规范（全部实现）：
- 卡片：面板底 #F0EEE6 + 1px 暖边框 #E5E2D9，圆角 12，几乎不用阴影。
- 当前轮到ta：边框变 warning #C4925A，背景叠一层极淡 accent-soft #F5E6DE。
- 是我：边框 accent #D97757。
- 庄家 D：左侧 3px warning 竖条。
- SB/BB：名字旁 pill 角标，accent-soft 底。
- All-in：左侧 3px danger 竖条 + "ALL" pill(danger 底)。
- 已弃牌：整体 opacity 0.4。
- 内容：左 名字(600)+角标；右 筹码(accent,600)，下方若有 currentBet 显示 "下注 N"(warning 色)。
```

### 组件 4 · PotDisplay + RoundBadge + CommunityCards
```
做三个小组件：
PotDisplay：居中，"底池"小标签(弱色) + 大数字(serif, 28-40px, accent 色)。
RoundBadge：pill，accent-soft 底 + accent 字，显示 翻牌前/翻牌/转牌/河牌/摊牌（中文映射在 state.round）。
CommunityCards：5 个卡槽横排居中，未发=凹陷灰块+暖边框，已发(下标<state.communityCards)=accent 边框+牌背图标。
```

### 组件 5 · ActionBar（体验最糙，重做重点）
```
做底部操作栏 ActionBar，props: { state, myPlayerId, send }，position fixed bottom，背景奶油+顶部1px暖边框，padding-bottom 用 max(12px, safe-area-inset-bottom)。
按状态切换三种模式（内部用派生判断）：
1) 摊牌(showdown)：调用 ShowdownPicker（见组件6）。
2) 本轮结束(非摊牌)：单个"下一轮"主按钮 → send({type:'nextRound'})。
3) 轮到我：三按钮 弃牌(danger,1) / 过牌|跟注(primary,1) / 加注(secondary,1.2)。
   - toCall = state.currentBet - 我的 currentBet；toCall=0 显示"过牌"否则"跟注 N"。
   - 点"加注"展开 RaiseControl：− [输入] + 步进(步长=bigBlind，上限=我的chips) + "加注"按钮。
   - 点击发送 send({type:'action', action, amount})。
不是我的回合且非上述状态：不显示操作栏。
```

### 组件 6 · ShowdownPicker（摊牌选获胜者）
```
做摊牌选获胜者组件 ShowdownPicker，props: { state, send }。
- 列出所有 !isFolded && isActive 的玩家，做成可多选的卡片/按钮，选中 accent 边框。
- 底部"确认"主按钮，至少选 1 人才能点；点击 send({type:'endHand', winnerIds:[...]}).
```

### 组件 7 · Toast
```
做 Toast 组件：屏幕中央，深色半透明底 #262624 + 反白字，圆角 12，300ms 淡入淡出，
pointer-events none。暴露 showToast(msg) 接口，订阅全局 error。
```

---

## 迭代技巧

- 每次让 Claude Design 改，**只说视觉/交互的 deltas**："把底池数字再大 20%""加注步进改成滑块"。
- 它容易擅自换冷色，发现就指出来："这个蓝不对，用 token 里的 accent #D97757"。
- 一个组件满意后，立刻复制 Code 到 `web/src/game/`，把 mock 换成真实 `state`/`send`，本地验证。
- 不要一次让它做整套，**逐组件**做，每个都打磨到位。
