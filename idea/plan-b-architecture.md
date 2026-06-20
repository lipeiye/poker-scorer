# 方案 B · 目标架构

把前端从单文件 HTML 升级为 **Vite + React + Tailwind + shadcn/ui** 工程，
组件来自 Claude Design，通过既有 WebSocket 协议对接**不动**的后端。

---

## 1. 目标目录结构

```
poker-scorer/
├── src/                         # 后端 —— 原封不动
│   ├── index.ts
│   ├── game-room.ts
│   ├── types.ts
│   └── env.ts
│
├── web/                         # 新增：前端工程
│   ├── package.json             # 独立依赖（react / vite / tailwind / framer-motion ...）
│   ├── tsconfig.json
│   ├── vite.config.ts           # build.outDir = '../public', emptyOutDir = true
│   ├── tailwind.config.ts       # 把 design-tokens.md 里的值注入 theme
│   ├── postcss.config.js
│   ├── index.html               # Vite 入口（<div id="root">）
│   └── src/
│       ├── main.tsx             # ReactDOM.createRoot
│       ├── App.tsx              # 路由 home/lobby/game 三个视图
│       ├── types.ts             # ← 从 ../src/types.ts 复制协议类型（PublicGameState 等）
│       ├── lib/
│       │   └── cn.ts            # shadcn 的 class 合并工具
│       ├── components/
│       │   └── ui/              # shadcn/ui 基础组件（button/input/dialog...）
│       ├── game/                # 业务组件（Claude Design 产物落地处）
│       │   ├── HomeScreen.tsx       # 首页：创建/加入房间
│       │   ├── Lobby.tsx            # 大厅：玩家列表 + 盲注设置 + 开始
│       │   ├── GameTable.tsx        # 游戏主界面容器
│       │   ├── TopBar.tsx           # 房间码 + 手数
│       │   ├── PotDisplay.tsx       # 底池
│       │   ├── RoundBadge.tsx       # 轮次标签
│       │   ├── CommunityCards.tsx   # 公共牌位
│       │   ├── PlayerCard.tsx       # 玩家卡（含 D/SB/BB/ALL/弃牌/轮到ta 变体）
│       │   ├── ActionBar.tsx        # 底部操作栏（弃牌/过牌|跟注/加注/下一轮）
│       │   ├── RaiseControl.tsx     # 加注金额步进
│       │   ├── ShowdownPicker.tsx   # 摊牌选获胜者
│       │   └── Toast.tsx            # 替代 prompt/alert
│       └── hooks/
│           └── useGameSocket.ts     # 封装 WS：连接/join/重连/发送/state
│
├── public/                      # Vite 构建产物（覆盖旧 index.html）
│   └── (vite build 生成)
│
├── idea/                        # 本交接文档
├── wrangler.toml                # 后端配置，不动
└── package.json                 # 后端依赖，不动
```

---

## 2. 关键设计决策

### 2.1 协议类型同源
`web/src/types.ts` = 从 `src/types.ts` 复制 `PublicGameState` / `Player` / `Round` / `Action`
/ `ClientMessage` / `ServerMessage` + 默认常量。

> 不直接 import 后端文件，是为了让前端工程能独立构建、不耦合 Cloudflare 类型。
> 若两份 drift，以前端这份为准去对齐（后端协议本身不变）。

### 2.2 WebSocket 逻辑集中到一个 hook
`useGameSocket(roomId, name)` 返回：
```ts
{
  state: PublicGameState | null,
  myPlayerId: string,
  send: (msg: ClientMessage) => void,   // 内部 ws.send(JSON.stringify)
  connected: boolean,
  error: string | null,
}
```
内部封装：open 后发 join（带 localStorage playerId）、onmessage 解析、onclose 重连、beforeunload close。
这样所有组件只通过这一个 hook 和后端打交道。

### 2.3 构建链（核心：产物落回 public/）
`web/vite.config.ts`：
```ts
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,   // 清掉旧 index.html
  },
});
```
这样 `cd web && npm run build` 后，Workers Static Assets serve `./public` 的行为**完全不变**，
线上部署零改动。

### 2.4 依赖建议
```jsonc
{
  "dependencies": {
    "react": "^18", "react-dom": "^18",
    "tailwindcss": "^3",        // 或 v4，按 Claude Design 产物对齐
    "clsx": "^2", "tailwind-merge": "^2",   // shadcn 的 cn()
    "lucide-react": "latest",   // 图标，和 Claude Design 产物对齐
    "framer-motion": "^11"      // 列表 stagger 等微动效
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4",
    "vite": "^5",
    "typescript": "^5"
  }
}
```
> 具体 shadcn/ui 组件按需 `npx shadcn@latest add button input dialog ...` 引入。

---

## 3. 开发期本地如何同时跑前后端

后端 `wrangler dev` 会 serve `./public`，但开发时你希望 **Vite 的 HMR + 热替换**。
两种做法：

### 做法 1（推荐，简单）：Vite dev 代理 WS 到 wrangler
- 终端 A：根目录 `npm run dev`（wrangler dev，默认 http://localhost:8787）
- 终端 B：`cd web && npm run dev`（vite dev，默认 http://localhost:5173）
- `web/vite.config.ts` 加代理：
  ```ts
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws':  { target: 'ws://localhost:8787', ws: true },
    }
  }
  ```
- 浏览器开 **http://localhost:5173**，前端走 HMR，API/WS 透明转发到后端。

### 做法 2（验证构建产物）：直接 build 后用 wrangler
`cd web && npm run build && cd .. && npm run dev`，浏览器开 8787，看的是真实部署形态。

---

## 4. 与 Claude Design 产物的衔接

Claude Design 默认产物是 **React 18 + TS + Tailwind + shadcn/ui + lucide**，
与 `web/` 技术栈完全一致，故：

1. 拿到组件源码 → 粘进 `web/src/game/` 对应文件。
2. 把组件内的 **mock 数据**替换为 `useGameSocket()` 的 `state`。
3. 把组件内的 **mock 动作**替换为 `send({type:'action',...})`。
4. 校验配色是否用了 `design-tokens.md` 的 token（Claude Design 容易自作主张用别的色，要纠）。

---

## 5. 不在本次范围（明确边界）

- ❌ 不改 `src/` 任何后端代码与协议。
- ❌ 不引入账号系统（现在用 localStorage 设备 ID，保持）。
- ❌ 不做真正的发牌/比牌（本项目是计分器，靠玩家手动选获胜者，这是有意设计）。
- ❌ 不改 `wrangler.toml` 的 DO 迁移配置。
