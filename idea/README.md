# Poker Scorer · UI 重做方案（Claude Design → 方案 B）

> 本文件夹是给**后续接手开发的 AI / 人**看的交接文档。
> 目标：用 Claude Design 产出的组件，按"方案 B（构建化 React 工程）"重做前端，后端保持不动。

---

## 这个项目现在是什么样

一个部署在 **Cloudflare Workers Free Tier** 的实时德州扑克计分器。

- **后端**：Workers + Durable Object（SQLite-backed）+ WebSocket，逻辑完整且干净，**不要改**。
- **前端**：`public/index.html` —— 单文件黑底界面（内联 CSS/JS、`prompt()` 取名字），**这次要重做的就是它**。

> 完整现状见 [`backend-protocol.md`](./backend-protocol.md)。

---

## 我们要做什么（方案 B 一句话）

把 `public/index.html` 这层"皮"换成 **Vite + React + Tailwind + shadcn/ui** 工程，
组件来自 **Claude Design** 生成的产物，通过**已有的 WebSocket 协议**对接**完全不动**的后端。

```
不动：src/index.ts · src/game-room.ts · src/types.ts（后端 + 协议）
新增：web/        （Vite + React 工程，构建产物输出到 public/）
来源：Claude Design 生成的组件  →  粘进 web/src/components/
```

> 目标架构和落地步骤见 [`plan-b-architecture.md`](./plan-b-architecture.md) 和 [`implementation-steps.md`](./implementation-steps.md)。

---

## 文件夹结构（本 idea 目录）

| 文件 | 内容 |
|---|---|
| `README.md` | 本文件：总览、开发工作流、Claude Design 提示词模板 |
| `design-tokens.md` | Claude 风格的设计 token（配色/字体/圆角/阴影）+ 组件视觉规范 |
| `backend-protocol.md` | 后端架构 + **WebSocket 消息协议（前后端对接的合同，最重要）** |
| `plan-b-architecture.md` | 方案 B 的目标目录结构与构建链 |
| `implementation-steps.md` | 逐步实施清单（含验证命令） |
| `claude-design-prompt.md` | 喂给 Claude Design 的完整提示词（已按本项目协议定制） |

---

## Claude Design 产物放哪

用户会把 Claude Design 导出的文件下载到 **`poker-scorer/` 根目录下**（本 `idea/` 的上一层）。
接手时先去那里找：

```
poker-scorer/
├── idea/                    ← 你在看的这里
├── <Claude Design 导出的文件>   ← 可能是 .html / .tsx / .zip，先找这里
├── public/index.html        ← 现在的旧前端（重做后会被构建产物覆盖）
└── src/                     ← 后端，不要动
```

找到产物后：解压/整理 → 逐个组件对照 [`design-tokens.md`](./design-tokens.md) 校验风格 →
按 [`implementation-steps.md`](./implementation-steps.md) 接进 `web/` 工程。

---

## 开发循环（每个组件都走一遍）

```
1. 拿到 Claude Design 的某个组件（如 PlayerCard）
2. 粘进 web/src/components/
3. 把组件里的 mock 状态/调用，换成 useGameSocket() 的真实数据与发送
   （映射关系见 backend-protocol.md 的"前端如何对应"表格）
4. cd web && npm run dev → 浏览器对真实后端验证
5. 满意后 npm run build（产物自动进 public/）
```

---

## 验证与部署（沿用现有命令，根目录执行）

```bash
npm install          # 后端依赖
npm run dev          # wrangler dev，含静态资源 + WebSocket，本地完整跑
npm run check        # typecheck + test + deploy --dry-run
npm run deploy       # 真正部署
```

> ⚠️ `web/` 是独立的 npm 工程，有自己的 install / build。根目录命令只管后端。
> 详见 `plan-b-architecture.md`。

---

## 给接手 AI 的三条铁律

1. **后端协议是合同，不要改 `src/`。** 前端去适配协议，不是反过来。
   `src/types.ts` 里的 `ClientMessage` / `ServerMessage` / `PublicGameState` 就是前后端共享的类型源头。
2. **先复制类型，再写组件。** 把 `PublicGameState` / `ClientMessage` / `ServerMessage`
   抄一份到 `web/src/types.ts`（或软链接），让前后端协议类型同源。
3. **构建产物必须落到 `public/`。** Workers 用 Static Assets serve `./public`，
   只要 Vite 输出到 `../public`，部署行为完全不变。
