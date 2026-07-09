# WORKLOG

## 2026-07-09 — 线下德扑逻辑审计修复

对照实际线下 NLHE 熟人局审查后，一次性修复高影响问题并部署。

### 修复清单

| # | 问题 | 修复 |
|---|------|------|
| 1 | **边池/未跟注筹码蒸发** | `awardPotsByTiers`：无合格者的层退还贡献者；仅 1 名合格者自动归其；≥2 名合格者但 tiers 未覆盖则**拒绝结算**并提示继续选名次 |
| 2 | **每日 ET 7:00 毁房 ≈ 北京 19–20 点** | 改为 **Asia/Shanghai 04:00**；手牌进行中（`round !== waiting`）**推迟 15 分钟**再清理，绝不中途销毁 |
| 3 | **挂机者不能选胜** | 前端候选改为 `!isFolded`（含 `isSittingOut`），与后端「仍争夺底池」一致 |
| 4 | **仅一人有筹码仍要逐街 check** | `shouldRunOutBoard()`：可行动人数 ≤1 时自动进摊牌（覆盖全员 all-in 与深筹 vs all-in） |
| 5 | **无补码** | 新消息 `rebuy`：waiting 态默认 +1000，大厅「+码」按钮 |
| 6 | **离线幽灵占座** | 新消息 `removePlayer`：waiting 态可移除离线玩家 |
| 7 | **BB 短码 currentBet 锁 bigBlind** | `currentBet = max(sbAmt, bbAmt)`（跟注对齐有效最高注；最小加注仍 ≥ bigBlind） |
| 8 | **不足额 all-in 完整重开** | 加注幅度 < bigBlind 时不 `resetActedFlags`（已行动者只需补跟） |
| 9 | **独胜后卡在 showdown** | `awardToSoloSurvivor` 结算成功后进入 `waiting`，可直接开下一手 |

### 涉及文件

- `src/game-room.ts` — 核心逻辑
- `src/types.ts` — `rebuy` / `removePlayer` 消息类型
- `public/scripts/render.js` — 摊牌候选、大厅补码/移除 UI
- `public/scripts/actions.js` / `app.js` — 补码/移除发送与事件
- `public/styles.css` — 大厅筹码行布局
- 静态资源 cache bust `?v=8`

### 未改（可接受简化）

- 最小加注增量仍固定为大盲（非「上次加注额」）——熟人局够用
- 无 straddle

### 验证

- 纯 Node 镜像 `awardPotsByTiers` 新算法：边池 / 未跟注退还 / 弃牌超额退还 / 未排满拒绝 / 单人边池自动 — 全部通过
- `npx tsc --noEmit` 通过
