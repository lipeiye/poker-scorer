import type { SettlementPayout } from './types';

export interface PotSettlementPlayer {
  id: string;
  name: string;
  totalBet: number;
  isFolded: boolean;
}

export interface PotLayerPlan {
  amount: number;
  winnerIds: string[];
  /** 未跟注筹码或已弃牌玩家的超额投入退还，不属于赢池。 */
  refund?: boolean;
}

export type PotPlanResult =
  | { ok: true; plans: PotLayerPlan[] }
  | { ok: false; message: string };

/**
 * 只读规划主池/边池，不修改玩家筹码或牌局状态。
 * tiers 按牌力从强到弱排列；每档允许多个平手玩家。
 */
export function planPotsByTiers(
  players: PotSettlementPlayer[],
  pot: number,
  tiers: string[][],
): PotPlanResult {
  const contributors = players.filter(player => player.totalBet > 0);
  if (contributors.length === 0 || pot <= 0) return { ok: true, plans: [] };

  const levels = Array.from(new Set(contributors.map(player => player.totalBet)))
    .sort((a, b) => a - b);
  const plans: PotLayerPlan[] = [];
  let previousLevel = 0;

  for (const level of levels) {
    const layerAmount = level - previousLevel;
    previousLevel = level;
    if (layerAmount <= 0) continue;

    const contributorsAtLayer = contributors.filter(player => player.totalBet >= level);
    const amount = layerAmount * contributorsAtLayer.length;
    if (amount <= 0) continue;

    const eligible = contributorsAtLayer.filter(player => !player.isFolded);
    const eligibleIds = new Set(eligible.map(player => player.id));

    if (eligibleIds.size === 0) {
      plans.push({
        amount,
        winnerIds: contributorsAtLayer.map(player => player.id),
        refund: true,
      });
      continue;
    }

    let winnerIds: string[] = [];
    for (const tier of tiers) {
      const matched = tier.filter(id => eligibleIds.has(id));
      if (matched.length > 0) {
        winnerIds = matched;
        break;
      }
    }

    if (winnerIds.length === 0) {
      if (eligibleIds.size === 1) {
        winnerIds = [eligible[0].id];
        plans.push({ amount, winnerIds, refund: true });
        continue;
      }
      return {
        ok: false,
        message: `边池尚未排完名次，请继续选择（涉及：${eligible.map(player => player.name).join('、')}）`,
      };
    }

    plans.push({ amount, winnerIds });
  }

  return { ok: true, plans };
}

/** 将分池计划展开并汇总为精确到玩家的筹码变化，包含余数归属。 */
export function buildSettlementPayouts(
  plans: PotLayerPlan[],
  players: PotSettlementPlayer[],
): SettlementPayout[] {
  const names = new Map(players.map(player => [player.id, player.name]));
  const payouts = new Map<string, SettlementPayout>();

  for (const plan of plans) {
    const share = Math.floor(plan.amount / plan.winnerIds.length);
    const remainder = plan.amount - share * plan.winnerIds.length;
    for (let index = 0; index < plan.winnerIds.length; index++) {
      const playerId = plan.winnerIds[index];
      const kind = plan.refund ? 'refund' : 'win';
      const key = `${kind}:${playerId}`;
      const amount = share + (index === 0 ? remainder : 0);
      const existing = payouts.get(key);
      if (existing) {
        existing.amount += amount;
      } else {
        payouts.set(key, {
          playerId,
          playerName: names.get(playerId) || '未知玩家',
          amount,
          kind,
        });
      }
    }
  }

  return Array.from(payouts.values());
}
