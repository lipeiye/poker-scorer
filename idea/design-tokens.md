# 设计系统 · Claude 风格 Token 与组件规范

本文件是前端视觉的"地基"。**所有 Claude Design 产出的组件都必须遵守这里的 token**，
否则各组件风格会漂移。第一次和 Claude Design 对话时就把这些贴进去。

---

## 1. 配色（奶油 + 暖灰 + 珊瑚橘，灵魂）

Claude 风格的关键：**不用纯白、不用纯黑、不用冷蓝**。

```css
:root {
  /* 背景 —— 奶油白，禁止大面积用 #FFFFFF */
  --bg-canvas:      #FAF9F5;   /* 页面底 */
  --bg-panel:       #F0EEE6;   /* 卡片/侧栏次级底 */
  --bg-sunken:      #ECE9DE;   /* 凹陷区、输入框底 */
  --bg-dark:        #262624;   /* 深色侧栏（Claude 标志性） */

  /* 文字 —— 暖系近黑，禁止 #000 */
  --text-primary:   #1A1A1A;
  --text-secondary: #5E5D58;
  --text-muted:     #8B8A82;
  --text-inverse:   #FAF9F5;   /* 深色底上的字 */

  /* 边框 —— 暖灰，低对比，营造"软"感 */
  --border-subtle:  #E5E2D9;
  --border-strong:  #D4D1C5;

  /* 强调色 —— Claude 招牌珊瑚橘，只用在 CTA / 聚焦态 */
  --accent:         #D97757;
  --accent-hover:   #C15F3C;
  --accent-soft:    #F5E6DE;   /* 背景式弱强调 */

  /* 状态色（保持低饱和，别破坏暖调） */
  --success: #5E8C6A;
  --warning: #C4925A;
  --danger:  #B5564F;
}
```

---

## 2. 字体（编辑感的来源）

Claude 标题是衬线体，正文是人文无衬线。

```css
:root {
  --font-serif: "Fraunces", "Newsreader", Georgia, "Songti SC", serif;       /* 标题 */
  --font-sans:  "Inter", -apple-system, "PingFang SC", sans-serif;           /* 正文 */
}
```

规则：
- **大标题用 serif**，字号大、字重 500（非 700）、`letter-spacing: -0.02em`。
- **正文行高 1.6–1.7**，给文字呼吸感。
- 中文：标题可配思源宋体 / 霞鹜文楷，正文 PingFang SC。

---

## 3. 形状、阴影、间距

```css
:root {
  --radius-sm: 8px;
  --radius-md: 12px;   /* 卡片、按钮默认 */
  --radius-lg: 16px;   /* 大容器、对话框 */
  --radius-pill: 999px;

  /* 阴影必须"软"——大模糊、低透明、暖色 */
  --shadow-sm: 0 1px 2px rgba(48, 45, 36, 0.04);
  --shadow-md: 0 4px 16px rgba(48, 45, 36, 0.06);
  --shadow-lg: 0 12px 40px rgba(48, 45, 36, 0.08);

  --space-unit: 4px;   /* 所有间距走 4 的倍数 */
  --ease: cubic-bezier(0.22, 1, 0.36, 1);  /* 动效曲线，时长 150–250ms，禁弹跳 */
}
```

> ⚠️ Claude 风格**少用阴影**，更多用 **1px 暖色边框 + 浅色背景层级**区分区块。
> 阴影只在悬浮卡片用，且极淡。

---

## 4. 组件视觉规范（映射到 Poker Scorer）

下面把游戏里每个组件对应成 Claude 风格的具体写法。

### 4.1 按钮
- **主按钮（CTA，如"开始游戏"/"加注"）**：实心 `--accent` 背景 + 白字，`--radius-md`，hover → `--accent-hover`。
- **次级按钮（如"加入房间"）**：透明底 + `--border-subtle` 1px 边框 + `--text-primary`。
- **危险按钮（"弃牌"）**：实心 `--danger` + 白字。
- 全部 `--radius-md`，高度 48–52px（移动端够大），`transition` 用 `--ease` 150ms。

### 4.2 输入框（房间码、名字、加注金额）
- 底色 `--bg-sunken`，1px `--border-subtle`。
- 聚焦：边框变 `--accent` + 一圈极淡光晕
  `box-shadow: 0 0 0 4px var(--accent-soft);`
- 房间码输入：`letter-spacing: 4px; text-transform: uppercase;`，居中。

### 4.3 玩家卡（PlayerCard）—— 最核心组件
- 底 `--bg-panel` 或纯白 + 1px 暖边框，`--radius-md`，**几乎不用阴影**。
- 状态化变体（**关键，必须都实现**）：
  | 状态 | 表现 |
  |---|---|
  | 当前轮到ta | 边框变 `--warning`（暖琥珀），背景 `--accent-soft` 极淡一层 |
  | 是我自己 | 边框 `--accent` |
  | 庄家 D | 左侧 3px `--warning` 竖条 |
  | 小盲 SB / 大盲 BB | 角标 pill，`--accent-soft` 底 |
  | All-in | 左侧 3px `--danger` 竖条 + "ALL" 角标 |
  | 已弃牌 | `opacity: 0.4` |
- 内容：名字（600 字重）+ 角标｜筹码（`--accent`，600）+ 当前下注（`--warning`）。

### 4.4 底池（PotDisplay）
- 居中，数字用 **serif 大字号**（28–40px），颜色 `--accent`。
- 上方小标签 "底池 / POT" 用 `--text-muted` 小字。

### 4.5 顶部栏（房间码 + 手数）
- 房间码：**serif、大、`letter-spacing: 2px`**，颜色 `--accent`（最醒目元素）。
- 手数 "第 N 手"：`--text-muted` 小字。

### 4.6 底部操作栏（ActionBar）—— 体验最糙，重做重点
- `position: fixed; bottom: 0`，背景 `--bg-canvas` + 顶部 1px `--border-subtle`。
- `padding-bottom: max(12px, env(safe-area-inset-bottom))`（适配 iPhone 底部）。
- 三按钮区：弃牌(1) / 跟注(1) / 加注(1.2) 的 flex 比例。
- 加注：展开一行"− [输入] + [加注]"，步进 = `bigBlind`。
- 轮次结束：换成单个"下一轮"主按钮。
- 摊牌阶段：列出未弃牌玩家做多选 + "确认"。

### 4.7 轮次标签（翻牌前/翻牌/转牌/河牌/摊牌）
- pill 形状，`--accent-soft` 底 + `--accent` 字，小字。

### 4.8 公共牌位（5 个卡槽）
- 未发：`--bg-sunken` + `--border-subtle`，占位灰块。
- 已发：`--accent` 边框 + 牌背图标。

---

## 5. 进阶"漂亮"技巧（做到这几点就有质感）

1. **留白比直觉多一倍**：区块间距 ≥ 32px。
2. **标题大胆用 serif 大字号**：首页 "PK" 标题可做 48–64px 衬线。
3. **微动效**：列表项 stagger 依次淡入上移（Framer Motion `staggerChildren`）。
4. **聚焦态永远可见**：键盘焦点 2px `--accent` 实线 + 2px 白色外环。
5. **Toast**（替代现在的 `prompt()`）：屏幕中央，`--bg-dark` 半透明 + 白字，`--radius-md`，300ms 淡入淡出。

---

## 6. 响应式

- **移动端优先**（这是个手机上多人同时用的工具），单栏布局。
- 操作栏永远 fixed 底部。
- 桌面端（`md:` 以上）可居中限宽（`max-width: 480px`），不必强行铺满。
