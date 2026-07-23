/**
 * 玩家谓词（Specification 模式的轻量纯函数形式）。
 * 与 GameRoom / 前端 isMyTurn 同源：改一处语义时两边必须同步读本文或复制同一规则。
 */
import type { Player } from './types';

/** 可行动：未弃牌、本手参与、未 all-in、未挂机 */
export function isActionable(p: Pick<Player, 'isFolded' | 'isActive' | 'isAllIn' | 'isSittingOut'>): boolean {
  return !p.isFolded && p.isActive && !p.isAllIn && !p.isSittingOut;
}

/** 争夺底池：仅看未弃牌（含挂机，防止断线独赢） */
export function isContesting(p: Pick<Player, 'isFolded'>): boolean {
  return !p.isFolded;
}

/** 本手是否占用行动环座位 */
export function isInActiveRing(p: Pick<Player, 'isActive'>): boolean {
  return p.isActive;
}
