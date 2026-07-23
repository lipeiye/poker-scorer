import { describe, expect, it } from 'vitest';
import { buildSettlementPayouts, planPotsByTiers } from '../src/pot-settlement';

const players = [
  { id: 'a', name: 'A', totalBet: 100, isFolded: false },
  { id: 'b', name: 'B', totalBet: 300, isFolded: false },
  { id: 'c', name: 'C', totalBet: 300, isFolded: false },
];

describe('planPotsByTiers', () => {
  it('按投入分层规划主池和边池，且不修改输入玩家', () => {
    const before = structuredClone(players);
    const result = planPotsByTiers(players, 700, [['a'], ['b'], ['c']]);

    expect(result).toEqual({
      ok: true,
      plans: [
        { amount: 300, winnerIds: ['a'] },
        { amount: 400, winnerIds: ['b'] },
      ],
    });
    expect(players).toEqual(before);
  });

  it('多人仍有资格但名次未排满时拒绝整次规划', () => {
    const result = planPotsByTiers(players, 700, [['a']]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('边池尚未排完名次');
  });

  it('单人未跟注层自动标记为退还，并给出精确预览金额', () => {
    const result = planPotsByTiers(
      [
        { id: 'a', name: 'A', totalBet: 100, isFolded: false },
        { id: 'b', name: 'B', totalBet: 150, isFolded: false },
      ],
      250,
      [['a']],
    );

    expect(result).toEqual({
      ok: true,
      plans: [
        { amount: 200, winnerIds: ['a'] },
        { amount: 50, winnerIds: ['b'], refund: true },
      ],
    });
    if (result.ok) {
      expect(buildSettlementPayouts(result.plans, [
        { id: 'a', name: 'A', totalBet: 100, isFolded: false },
        { id: 'b', name: 'B', totalBet: 150, isFolded: false },
      ])).toEqual([
        { playerId: 'a', playerName: 'A', amount: 200, kind: 'win' },
        { playerId: 'b', playerName: 'B', amount: 50, kind: 'refund' },
      ]);
    }
  });
});
