import { env, SELF, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { PublicGameState } from '../src/types';

async function getRoomStub(roomId: string) {
  const id = env.GAME_ROOM.idFromName(roomId);
  return env.GAME_ROOM.get(id);
}

async function initRoom(roomId: string, smallBlind = 10, bigBlind = 20) {
  const stub = await getRoomStub(roomId);
  const res = await stub.fetch(
    new Request(`https://internal/api/rooms/${roomId}/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smallBlind, bigBlind }),
    })
  );
  expect(res.status).toBe(200);
  return stub;
}

async function fetchState(stub: DurableObjectStub, roomId: string): Promise<PublicGameState> {
  const res = await stub.fetch(`https://internal/api/rooms/${roomId}/state`);
  return (await res.json()) as PublicGameState;
}

class TestSocket {
  public messages: any[] = [];

  async connect(stub: DurableObjectStub, roomId: string): Promise<WebSocket> {
    const res = await stub.fetch(
      new Request(`https://internal/ws/${roomId}`, {
        headers: { Upgrade: 'websocket' },
      })
    );
    expect(res.status).toBe(101);

    const client = res.webSocket!;
    client.accept();
    client.addEventListener('message', (e: MessageEvent) => {
      this.messages.push(JSON.parse(e.data));
    });

    return client;
  }

  send(ws: WebSocket, msg: object) {
    ws.send(JSON.stringify(msg));
  }

  lastState(): PublicGameState | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].type === 'state') return this.messages[i].state;
    }
  }

  errors(): any[] {
    return this.messages.filter(m => m.type === 'error');
  }
}

describe('GameRoom 基础流程', () => {
  it('创建房间并返回正确配置', async () => {
    const stub = await initRoom('ROOM01', 5, 10);
    const state = await fetchState(stub, 'ROOM01');
    expect(state.roomId).toBe('ROOM01');
    expect(state.smallBlind).toBe(5);
    expect(state.bigBlind).toBe(10);
    expect(state.round).toBe('waiting');
  });

  it('玩家可以加入房间，最多12人', async () => {
    const stub = await initRoom('ROOM02');
    const socket = new TestSocket();
    const ws = await socket.connect(stub, 'ROOM02');

    socket.send(ws, { type: 'join', name: 'Alice', playerId: 'p1' });
    await new Promise(r => setTimeout(r, 50));

    let state = socket.lastState()!;
    expect(state.players.length).toBe(1);
    expect(state.players[0].name).toBe('Alice');

    for (let i = 2; i <= 12; i++) {
      const s2 = new TestSocket();
      const w2 = await s2.connect(stub, 'ROOM02');
      s2.send(w2, { type: 'join', name: `P${i}`, playerId: `p${i}` });
    }
    await new Promise(r => setTimeout(r, 300));

    state = await fetchState(stub, 'ROOM02');
    expect(state.players.length).toBe(12);

    const s13 = new TestSocket();
    const w13 = await s13.connect(stub, 'ROOM02');
    s13.send(w13, { type: 'join', name: 'Overflow', playerId: 'p13' });
    await new Promise(r => setTimeout(r, 100));
    expect(s13.errors().length).toBeGreaterThan(0);
  });

  it('游戏中途不允许新玩家加入', async () => {
    const stub = await initRoom('ROOM03');
    const s1 = new TestSocket();
    const w1 = await s1.connect(stub, 'ROOM03');
    s1.send(w1, { type: 'join', name: 'A', playerId: 'a' });

    const s2 = new TestSocket();
    const w2 = await s2.connect(stub, 'ROOM03');
    s2.send(w2, { type: 'join', name: 'B', playerId: 'b' });
    await new Promise(r => setTimeout(r, 50));

    s1.send(w1, { type: 'startHand' });
    await new Promise(r => setTimeout(r, 50));

    const s3 = new TestSocket();
    const w3 = await s3.connect(stub, 'ROOM03');
    s3.send(w3, { type: 'join', name: 'C', playerId: 'c' });
    await new Promise(r => setTimeout(r, 50));
    expect(s3.errors().length).toBeGreaterThan(0);
  });

  it('直接通过 WebSocket 加入时使用正确房间号', async () => {
    const stub = await getRoomStub('ROOM11');
    const socket = new TestSocket();
    const ws = await socket.connect(stub, 'ROOM11');
    socket.send(ws, { type: 'join', name: 'Direct' });
    await new Promise(r => setTimeout(r, 50));

    expect(socket.lastState()?.roomId).toBe('ROOM11');
  });
});

describe('GameRoom 手牌流程', () => {
  it('2人桌：开始手牌、盲注、行动顺序', async () => {
    const stub = await initRoom('ROOM04');
    const s1 = new TestSocket();
    const w1 = await s1.connect(stub, 'ROOM04');
    s1.send(w1, { type: 'join', name: 'A', playerId: 'a' });

    const s2 = new TestSocket();
    const w2 = await s2.connect(stub, 'ROOM04');
    s2.send(w2, { type: 'join', name: 'B', playerId: 'b' });
    await new Promise(r => setTimeout(r, 50));

    s1.send(w1, { type: 'startHand' });
    await new Promise(r => setTimeout(r, 50));

    let state = await fetchState(stub, 'ROOM04');
    expect(state.round).toBe('preflop');
    expect(state.players.length).toBe(2);
    expect(state.pot).toBe(30);
    expect(state.currentBet).toBe(20);

    const dealerIdx = state.dealerIndex;
    expect(state.currentPlayerIndex).toBe(dealerIdx);

    s1.send(w1, { type: 'action', action: 'call' });
    await new Promise(r => setTimeout(r, 50));
    state = await fetchState(stub, 'ROOM04');
    expect(state.currentPlayerIndex).toBe((dealerIdx + 1) % 2);

    const bbWs = state.players[(dealerIdx + 1) % 2].name === 'A' ? w1 : w2;
    s1.send(bbWs, { type: 'action', action: 'check' });
    await new Promise(r => setTimeout(r, 50));
    state = await fetchState(stub, 'ROOM04');
    expect(state.lastAction).toContain('本轮下注完成');
  });

  it('3人桌：UTG 先行动，SB/BB 顺序正确', async () => {
    const stub = await initRoom('ROOM05');
    const sockets: { ws: WebSocket; name: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const s = new TestSocket();
      const w = await s.connect(stub, 'ROOM05');
      const name = String.fromCharCode(65 + i);
      s.send(w, { type: 'join', name, playerId: `p${i}` });
      sockets.push({ ws: w, name });
    }
    await new Promise(r => setTimeout(r, 100));

    sockets[0].ws.send(JSON.stringify({ type: 'startHand' }));
    await new Promise(r => setTimeout(r, 50));

    let state = await fetchState(stub, 'ROOM05');
    expect(state.round).toBe('preflop');
    expect(state.currentPlayerIndex).toBe((state.dealerIndex + 3) % 3);
  });
});

describe('GameRoom 极限与异常场景', () => {
  it('同一玩家的连续重复操作只生效一次', async () => {
    const stub = await initRoom('ROOM12');
    const first = new TestSocket();
    const firstWs = await first.connect(stub, 'ROOM12');
    first.send(firstWs, { type: 'join', name: 'A' });
    const second = new TestSocket();
    const secondWs = await second.connect(stub, 'ROOM12');
    second.send(secondWs, { type: 'join', name: 'B' });
    await new Promise(r => setTimeout(r, 50));

    first.send(firstWs, { type: 'startHand' });
    await new Promise(r => setTimeout(r, 50));
    first.send(firstWs, { type: 'action', action: 'call' });
    first.send(firstWs, { type: 'action', action: 'fold' });
    await new Promise(r => setTimeout(r, 100));

    const state = await fetchState(stub, 'ROOM12');
    expect(state.players[0].isFolded).toBe(false);
    expect(state.players[0].currentBet).toBe(20);
    expect(state.currentPlayerIndex).toBe(1);
  });

  it('玩家手牌中断线：保持座位(isActive)、转为坐出挂机(isSittingOut)，不 fold', async () => {
    const stub = await initRoom('ROOM06');
    const sockets: TestSocket[] = [];
    const wsList: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const s = new TestSocket();
      const w = await s.connect(stub, 'ROOM06');
      s.send(w, { type: 'join', name: `P${i}`, playerId: `p${i}` });
      sockets.push(s);
      wsList.push(w);
    }
    await new Promise(r => setTimeout(r, 100));

    wsList[0].send(JSON.stringify({ type: 'startHand' }));
    await new Promise(r => setTimeout(r, 50));

    let state = await fetchState(stub, 'ROOM06');
    expect(state.round).toBe('preflop');

    // 模拟中间玩家断线
    wsList[1].close();
    await new Promise(r => setTimeout(r, 100));

    state = await fetchState(stub, 'ROOM06');
    const disconnected = state.players[1];
    expect(disconnected.isConnected).toBe(false);
    // 新语义：断线者保持座位(isActive 仍 true)、转为坐出挂机、不 fold
    expect(disconnected.isSittingOut).toBe(true);
    expect(disconnected.isActive).toBe(true);
    expect(disconnected.isFolded).toBe(false);
    // 底池不被提前发放，仍处于手牌中
    expect(state.round).toBe('preflop');
    expect(state.lastWinnerIds).toHaveLength(0);
  });

  it('筹码为0的玩家不应参与手牌', async () => {
    const stub = await initRoom('ROOM07', 10, 20);
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 2; i++) {
      const s = new TestSocket();
      const w = await s.connect(stub, 'ROOM07');
      s.send(w, { type: 'join', name: `P${i}`, playerId: `p${i}` });
      sockets.push(w);
    }
    await new Promise(r => setTimeout(r, 50));

    sockets[0].send(JSON.stringify({ type: 'startHand' }));
    await new Promise(r => setTimeout(r, 50));

    sockets[0].send(JSON.stringify({ type: 'action', action: 'raise', amount: 990 }));
    await new Promise(r => setTimeout(r, 50));
    sockets[1].send(JSON.stringify({ type: 'action', action: 'call' }));
    await new Promise(r => setTimeout(r, 50));

    let state = await fetchState(stub, 'ROOM07');
    expect(state.pot).toBe(2000);

    for (let i = 0; i < 4; i++) {
      sockets[0].send(JSON.stringify({ type: 'nextRound' }));
      await new Promise(r => setTimeout(r, 30));
    }
    state = await fetchState(stub, 'ROOM07');
    expect(state.round).toBe('showdown');

    sockets[0].send(JSON.stringify({ type: 'endHand', winnerIds: [state.players[0].id] }));
    await new Promise(r => setTimeout(r, 50));
    state = await fetchState(stub, 'ROOM07');
    expect(state.lastWinnerIds).toEqual([state.players[0].id]);

    sockets[0].send(JSON.stringify({ type: 'startHand' }));
    await new Promise(r => setTimeout(r, 50));

    state = await fetchState(stub, 'ROOM07');
    expect(state.round).toBe('waiting');
    expect(state.players[0].chips).toBe(2000);
    expect(state.players[1].chips).toBe(0);
    expect(state.players[1].isActive).toBe(false);
  });

  it('all-in 不足额时 currentBet 不应异常降低', async () => {
    const stub = await initRoom('ROOM08', 10, 20);
    const s1 = new TestSocket();
    const w1 = await s1.connect(stub, 'ROOM08');
    s1.send(w1, { type: 'join', name: 'A', playerId: 'a' });

    const s2 = new TestSocket();
    const w2 = await s2.connect(stub, 'ROOM08');
    s2.send(w2, { type: 'join', name: 'B', playerId: 'b' });
    await new Promise(r => setTimeout(r, 50));

    s1.send(w1, { type: 'startHand' });
    await new Promise(r => setTimeout(r, 50));

    s1.send(w1, { type: 'action', action: 'raise', amount: 1000 });
    await new Promise(r => setTimeout(r, 50));

    let state = await fetchState(stub, 'ROOM08');
    expect(state.currentBet).toBe(1000);
    expect(state.pot).toBe(1020);

    s2.send(w2, { type: 'action', action: 'call' });
    await new Promise(r => setTimeout(r, 50));
    state = await fetchState(stub, 'ROOM08');
    expect(state.pot).toBe(2000);
  });

  it('游戏进行中修改盲注应被拒绝', async () => {
    const stub = await initRoom('ROOM09');
    const s1 = new TestSocket();
    const w1 = await s1.connect(stub, 'ROOM09');
    s1.send(w1, { type: 'join', name: 'A', playerId: 'a' });

    const s2 = new TestSocket();
    const w2 = await s2.connect(stub, 'ROOM09');
    s2.send(w2, { type: 'join', name: 'B', playerId: 'b' });
    await new Promise(r => setTimeout(r, 50));

    s1.send(w1, { type: 'startHand' });
    await new Promise(r => setTimeout(r, 50));

    s1.send(w1, { type: 'updateSettings', settings: { smallBlind: 50, bigBlind: 100 } });
    await new Promise(r => setTimeout(r, 50));

    const state = await fetchState(stub, 'ROOM09');
    expect(state.smallBlind).toBe(10);
    expect(state.bigBlind).toBe(20);
  });

  it('下一轮必须在下注完成后才能进入', async () => {
    const stub = await initRoom('ROOM10');
    const s1 = new TestSocket();
    const w1 = await s1.connect(stub, 'ROOM10');
    s1.send(w1, { type: 'join', name: 'A', playerId: 'a' });

    const s2 = new TestSocket();
    const w2 = await s2.connect(stub, 'ROOM10');
    s2.send(w2, { type: 'join', name: 'B', playerId: 'b' });
    await new Promise(r => setTimeout(r, 50));

    s1.send(w1, { type: 'startHand' });
    await new Promise(r => setTimeout(r, 50));

    s1.send(w1, { type: 'nextRound' });
    await new Promise(r => setTimeout(r, 50));

    const state = await fetchState(stub, 'ROOM10');
    expect(state.round).toBe('preflop');
  });

  it('复现：flop 完成进入 turn 后，首动者应能弃牌（currentPlayerIndex 有效、isRoundComplete=false）', async () => {
    const stub = await initRoom('TURN01', 10, 20);
    const wsList: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const s = new TestSocket();
      const w = await s.connect(stub, 'TURN01');
      s.send(w, { type: 'join', name: `P${i}`, deviceId: `d${i}` });
      wsList.push(w);
    }
    await new Promise(r => setTimeout(r, 100));

    const send = (ws: WebSocket, m: object) => ws.send(JSON.stringify(m));
    wsList[0].send(JSON.stringify({ type: 'startHand' }));
    await new Promise(r => setTimeout(r, 50));

    // 走完 preflop：UTG call、SB call、BB check（或按 currentPlayerIndex 顺序）
    // 简化：循环让 currentPlayerIndex 对应玩家 call/check，直到本轮完成
    let state = await fetchState(stub, 'TURN01');
    const wsForPlayer = (idx: number) => {
      const pid = state.players[idx].id;
      // 找到该玩家对应的 ws（按 deviceId 映射不可得，这里用 join 顺序 = 数组顺序）
      return wsList[idx];
    };
    // preflop 推进：最多行动若干次直到 isRoundComplete
    for (let i = 0; i < 6; i++) {
      state = await fetchState(stub, 'TURN01');
      const actionable = state.players.filter((p) => !p.isFolded && p.isActive && !p.isAllIn);
      const done = actionable.length > 0 && actionable.every((p) => p.hasActedThisRound && p.currentBet === state.currentBet);
      if (done) break;
      const cur = state.currentPlayerIndex;
      if (cur < 0) break;
      const toCall = state.currentBet - state.players[cur].currentBet;
      send(wsForPlayer(cur), { type: 'action', action: toCall > 0 ? 'call' : 'check' });
      await new Promise(r => setTimeout(r, 40));
    }

    // 进 flop
    send(wsList[0], { type: 'nextRound' });
    await new Promise(r => setTimeout(r, 50));
    state = await fetchState(stub, 'TURN01');
    expect(state.round).toBe('flop');

    // 走完 flop（全员 check 一圈）
    for (let i = 0; i < 6; i++) {
      state = await fetchState(stub, 'TURN01');
      const actionable = state.players.filter((p) => !p.isFolded && p.isActive && !p.isAllIn);
      const done = actionable.length > 0 && actionable.every((p) => p.hasActedThisRound && p.currentBet === state.currentBet);
      if (done) break;
      const cur = state.currentPlayerIndex;
      if (cur < 0) break;
      send(wsForPlayer(cur), { type: 'action', action: 'check' });
      await new Promise(r => setTimeout(r, 40));
    }

    // 进 turn（第四张牌）
    send(wsList[0], { type: 'nextRound' });
    await new Promise(r => setTimeout(r, 50));
    state = await fetchState(stub, 'TURN01');
    expect(state.round).toBe('turn');
    expect(state.communityCards).toBe(4);

    // 关键断言：turn 首动者应有有效 currentPlayerIndex，且 isRoundComplete=false
    expect(state.currentPlayerIndex).toBeGreaterThanOrEqual(0);
    const actionable = state.players.filter((p) => !p.isFolded && p.isActive && !p.isAllIn && !(p as any).isSittingOut);
    const isComplete = actionable.length === 0 || actionable.every((p) => p.hasActedThisRound && p.currentBet === state.currentBet);
    expect(isComplete).toBe(false);
    // 首动者未行动
    const firstActor = state.players[state.currentPlayerIndex];
    expect(firstActor.hasActedThisRound).toBe(false);
  });
});

describe('GameRoom 每日重置', () => {
  it('日期字符串比较应使用补零格式', () => {
    const a = '2026-10-1';
    const b = '2026-9-30';
    expect(a > b).toBe(false);
  });
});

describe('并发重连与盲注防御', () => {
  it('盲注 SB 与 BB 必须落在两个不同玩家身上（3人桌）', async () => {
    const stub = await initRoom('BLIND01', 10, 20);
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const s = new TestSocket();
      const w = await s.connect(stub, 'BLIND01');
      s.send(w, { type: 'join', name: `P${i}`, playerId: `p${i}` });
      sockets.push(w);
    }
    await new Promise(r => setTimeout(r, 100));

    sockets[0].send(JSON.stringify({ type: 'startHand' }));
    await new Promise(r => setTimeout(r, 50));

    const state = await fetchState(stub, 'BLIND01');
    expect(state.round).toBe('preflop');
    // pot 应为 SB(10) + BB(20) = 30，证明盲注由两位不同玩家各付一次
    expect(state.pot).toBe(30);
    expect(state.currentBet).toBe(20);

    // 直接核对：恰有一人 currentBet==10(SB)，恰有一人 currentBet==20(BB)
    const sb = state.players.filter(p => p.currentBet === 10);
    const bb = state.players.filter(p => p.currentBet === 20);
    expect(sb.length).toBe(1);
    expect(bb.length).toBe(1);
    expect(sb[0].id).not.toBe(bb[0].id);
  });

  it('重复 join 同一玩家不会把该玩家判离线', async () => {
    const stub = await initRoom('RCN100');
    const s1 = new TestSocket();
    const w1 = await s1.connect(stub, 'RCN100');
    s1.send(w1, { type: 'join', name: 'Alice', playerId: 'alice', deviceId: 'd1' });
    await new Promise(r => setTimeout(r, 50));

    // 模拟并发重连：同一玩家几乎同时建立两条新连接并发 join
    const s2 = new TestSocket();
    const w2 = await s2.connect(stub, 'RCN100');
    const s3 = new TestSocket();
    const w3 = await s3.connect(stub, 'RCN100');
    s2.send(w2, { type: 'join', name: 'Alice', playerId: 'alice', deviceId: 'd1' });
    s3.send(w3, { type: 'join', name: 'Alice', playerId: 'alice', deviceId: 'd1' });
    await new Promise(r => setTimeout(r, 150));

    const state = await fetchState(stub, 'RCN100');
    expect(state.players).toHaveLength(1);
    expect(state.players[0].isConnected).toBe(true);
  });
});

describe('断线坐出(sitting-out)语义', () => {
  it('断线者轮到行动时纯跳过：行动权转给下一位，筹码/下注不变', async () => {
    const stub = await initRoom('SITOUT01', 10, 20);
    const socks: TestSocket[] = [];
    const wsList: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const s = new TestSocket();
      const w = await s.connect(stub, 'SITOUT01');
      s.send(w, { type: 'join', name: `P${i}`, playerId: `p${i}` });
      socks.push(s);
      wsList.push(w);
    }
    await new Promise(r => setTimeout(r, 100));
    wsList[0].send(JSON.stringify({ type: 'startHand' }));
    await new Promise(r => setTimeout(r, 50));

    let state = await fetchState(stub, 'SITOUT01');
    const currentIdx = state.currentPlayerIndex;
    expect(currentIdx).toBeGreaterThanOrEqual(0);
    const before = state.players[currentIdx];
    const beforeChips = before.chips;
    const beforeTotalBet = before.totalBet;

    // 当前行动者断线 → 应自动跳到下一位，断线者筹码/下注不变
    wsList[currentIdx].close();
    await new Promise(r => setTimeout(r, 100));

    state = await fetchState(stub, 'SITOUT01');
    // 仍处于翻牌前，未提前判胜
    expect(state.round).toBe('preflop');
    expect(state.lastWinnerIds).toHaveLength(0);
    // 行动权已转给"另一位"可行动玩家
    expect(state.currentPlayerIndex).not.toBe(currentIdx);
    expect(state.currentPlayerIndex).toBeGreaterThanOrEqual(0);
    const after = state.players[currentIdx];
    expect(after.chips).toBe(beforeChips);
    expect(after.totalBet).toBe(beforeTotalBet);
    expect(after.isSittingOut).toBe(true);
    expect(after.isFolded).toBe(false);
  });

  it('断线不应让人提前独胜底池（即便只剩一个未断线者也不直接判赢）', async () => {
    const stub = await initRoom('SITOUT02', 10, 20);
    const socks: TestSocket[] = [];
    const wsList: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const s = new TestSocket();
      const w = await s.connect(stub, 'SITOUT02');
      s.send(w, { type: 'join', name: `P${i}`, playerId: `p${i}` });
      socks.push(s);
      wsList.push(w);
    }
    await new Promise(r => setTimeout(r, 100));
    wsList[0].send(JSON.stringify({ type: 'startHand' }));
    await new Promise(r => setTimeout(r, 50));

    // 两个非当前行动者都断线，只留一个在线玩家
    wsList[0].close();
    wsList[1].close();
    await new Promise(r => setTimeout(r, 150));

    const state = await fetchState(stub, 'SITOUT02');
    // 关键：不能因断线直接判独胜，仍应处于手牌中
    expect(state.round).toBe('preflop');
    expect(state.lastWinnerIds).toHaveLength(0);
    const onlineCount = state.players.filter(p => p.isConnected).length;
    expect(onlineCount).toBe(1);
  });

  it('手牌进行中重连仍保持挂机，下一手发牌才复活', async () => {
    const stub = await initRoom('SITOUT03', 10, 20);
    const s1 = new TestSocket();
    const w1 = await s1.connect(stub, 'SITOUT03');
    s1.send(w1, { type: 'join', name: 'A', deviceId: 'da' });
    const s2 = new TestSocket();
    const w2 = await s2.connect(stub, 'SITOUT03');
    s2.send(w2, { type: 'join', name: 'B', deviceId: 'db' });
    const s3 = new TestSocket();
    const w3 = await s3.connect(stub, 'SITOUT03');
    s3.send(w3, { type: 'join', name: 'C', deviceId: 'dc' });
    await new Promise(r => setTimeout(r, 100));
    let state = await fetchState(stub, 'SITOUT03');
    const cId = state.players[2].id;

    w1.send(JSON.stringify({ type: 'startHand' }));
    await new Promise(r => setTimeout(r, 50));

    // C 断线
    w3.close();
    await new Promise(r => setTimeout(r, 100));
    state = await fetchState(stub, 'SITOUT03');
    expect(state.players[2].isSittingOut).toBe(true);

    // C 手牌中重连（用真实 playerId + deviceId）→ 仍挂机
    const s3b = new TestSocket();
    const w3b = await s3b.connect(stub, 'SITOUT03');
    s3b.send(w3b, { type: 'join', name: 'C', playerId: cId, deviceId: 'dc' });
    await new Promise(r => setTimeout(r, 100));
    state = await fetchState(stub, 'SITOUT03');
    const C = state.players[2];
    expect(C.isConnected).toBe(true);
    expect(C.isSittingOut).toBe(true); // 本手牌仍挂机

    // 推进到摊牌并结束这手牌 → waiting
    // A 全押、B 跟注后，本轮(preflop)下注完成，需手动 nextRound 走到摊牌。
    w1.send(JSON.stringify({ type: 'action', action: 'raise', amount: 1000 }));
    await new Promise(r => setTimeout(r, 40));
    w2.send(JSON.stringify({ type: 'action', action: 'call' }));
    await new Promise(r => setTimeout(r, 40));
    for (let i = 0; i < 4; i++) {
      w1.send(JSON.stringify({ type: 'nextRound' }));
      await new Promise(r => setTimeout(r, 30));
    }
    state = await fetchState(stub, 'SITOUT03');
    if (state.round === 'showdown') {
      const winnerId = state.players.find(p => p.isConnected)!.id;
      w1.send(JSON.stringify({ type: 'endHand', winnerIds: [winnerId] }));
      await new Promise(r => setTimeout(r, 50));
    }
    state = await fetchState(stub, 'SITOUT03');
    expect(state.round).toBe('waiting');

    // 下一手开始后 C 复活
    w1.send(JSON.stringify({ type: 'startHand' }));
    await new Promise(r => setTimeout(r, 50));
    state = await fetchState(stub, 'SITOUT03');
    const C2 = state.players[2];
    expect(C2.isSittingOut).toBe(false);
    expect(C2.isActive).toBe(true);
  });
});


describe('房间目录、过期与重连', () => {
  it('不存在的房间码返回 404，不会被隐式创建', async () => {
    const response = await SELF.fetch('https://example.com/api/rooms/ABCDEF/exists');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: '房间码不存在或已过期' });

    const malformed = await SELF.fetch('https://example.com/api/rooms/000000/exists');
    expect(malformed.status).toBe(404);
  });

  it('通过 API 创建的房间可以被目录查询', async () => {
    const createResponse = await SELF.fetch('https://example.com/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smallBlind: 5, bigBlind: 10 }),
    });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json<{ roomId: string }>();

    const existsResponse = await SELF.fetch(
      `https://example.com/api/rooms/${created.roomId}/exists`
    );
    expect(existsResponse.status).toBe(200);
    expect(await existsResponse.json()).toMatchObject({
      exists: true,
      roomId: created.roomId,
    });
  });

  it('同一设备离开等待区后重连，恢复为同一玩家', async () => {
    const stub = await initRoom('RCN001');
    const first = new TestSocket();
    const firstWs = await first.connect(stub, 'RCN001');
    first.send(firstWs, { type: 'join', name: 'Alice', deviceId: 'device-alice' });
    await new Promise(r => setTimeout(r, 50));
    const originalId = first.lastState()!.players[0].id;

    first.send(firstWs, { type: 'leave' });
    await new Promise(r => setTimeout(r, 50));

    const second = new TestSocket();
    const secondWs = await second.connect(stub, 'RCN001');
    second.send(secondWs, { type: 'join', name: 'Alice', deviceId: 'device-alice' });
    await new Promise(r => setTimeout(r, 50));

    const state = second.lastState()!;
    expect(state.players).toHaveLength(1);
    expect(state.players[0].id).toBe(originalId);
    expect(state.players[0].chips).toBe(1000);
    expect(state.players[0].isConnected).toBe(true);
  });

  it('房间闹钟触发后彻底删除房间存储和目录记录', async () => {
    const roomId = 'EXP001';
    const expiresAt = Date.now() + 200;
    const registry = env.ROOM_REGISTRY.getByName(roomId);
    expect(await registry.claim(expiresAt)).toBe(true);

    const stub = await getRoomStub(roomId);
    const initResponse = await stub.fetch(
      new Request(`https://internal/api/rooms/${roomId}/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ smallBlind: 10, bigBlind: 20, expiresAt }),
      })
    );
    expect(initResponse.status).toBe(200);

    await new Promise(r => setTimeout(r, 240));
    await runDurableObjectAlarm(stub);
    expect(await registry.exists()).toBe(false);
    await runInDurableObject(stub, async (_instance, state) => {
      expect((await state.storage.list()).size).toBe(0);
    });

    const existsResponse = await stub.fetch(
      `https://internal/api/rooms/${roomId}/exists`
    );
    expect(await existsResponse.json()).toMatchObject({ exists: false });
  });
});
