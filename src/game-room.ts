import { DurableObject } from 'cloudflare:workers';
import type { Player, Round, Action, GameState, ClientMessage, PublicGameState } from './types';
import { DEFAULT_CHIPS, DEFAULT_SMALL_BLIND, DEFAULT_BIG_BLIND, ROOM_TTL_MS, getRoundName } from './types';
import type { Env } from './env';

interface SocketAttachment {
  playerId?: string;
}

export class GameRoom extends DurableObject<Env> {
  private game!: GameState;
  private connections: Map<WebSocket, string>;
  private lastResetDate: string;
  private expired: boolean;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.connections = new Map();
    this.lastResetDate = '';
    this.expired = false;
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get<GameState>('game');
      const savedDate = await this.ctx.storage.get<string>('lastResetDate');

      if (!saved) return;

      this.game = saved;
      this.game.expiresAt ||= this.game.createdAt + ROOM_TTL_MS;
      this.game.playerDevices ||= {};
      this.game.lastWinnerIds ||= [];
      this.lastResetDate = savedDate || '';
      this.game.players.forEach(player => {
        player.isConnected = false;
      });

      for (const ws of this.ctx.getWebSockets()) {
        const attachment = ws.deserializeAttachment() as SocketAttachment | null;
        if (!attachment?.playerId) continue;

        this.connections.set(ws, attachment.playerId);
        const player = this.game.players.find(candidate => candidate.id === attachment.playerId);
        if (player) {
          player.isConnected = true;
        }
      }

      await this.checkDailyReset();
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (currentAlarm === null) {
        await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, this.game.expiresAt));
      }
    });
  }

  private async loadOrCreate(roomId: string): Promise<void> {
    await this.ready;
    if (!this.game) {
      this.game = {
        roomId,
        players: [],
        round: 'waiting',
        pot: 0,
        currentBet: 0,
        dealerIndex: 0,
        currentPlayerIndex: -1,
        smallBlind: DEFAULT_SMALL_BLIND,
        bigBlind: DEFAULT_BIG_BLIND,
        handNumber: 0,
        lastAction: '',
        lastActor: '',
        lastWinnerIds: [],
        communityCards: 0,
        createdAt: Date.now(),
        expiresAt: Date.now() + ROOM_TTL_MS,
        playerDevices: {},
      };
      await this.ctx.storage.setAlarm(this.game.expiresAt);
    }

    await this.checkDailyReset();
  }

  private async checkDailyReset(): Promise<void> {
    const resetDate = this.currentResetDate();
    if (this.lastResetDate && resetDate > this.lastResetDate) {
      this.game = {
        roomId: this.game.roomId,
        players: [],
        round: 'waiting',
        pot: 0,
        currentBet: 0,
        dealerIndex: 0,
        currentPlayerIndex: -1,
        smallBlind: DEFAULT_SMALL_BLIND,
        bigBlind: DEFAULT_BIG_BLIND,
        handNumber: 0,
        lastAction: '每日自动重置',
        lastActor: '',
        lastWinnerIds: [],
        communityCards: 0,
        createdAt: Date.now(),
        expiresAt: this.game.expiresAt,
        playerDevices: {},
      };
      this.lastResetDate = resetDate;
      await this.ctx.storage.put({
        lastResetDate: resetDate,
        game: this.game,
      });
    } else if (!this.lastResetDate) {
      this.lastResetDate = resetDate;
      await this.ctx.storage.put('lastResetDate', resetDate);
    }
  }

  private currentResetDate(now = Date.now()): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(now - 4 * 60 * 60 * 1000));
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find(part => part.type === type)?.value || '';
    return `${value('year')}-${value('month')}-${value('day')}`;
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put('game', this.game);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const pathParts = url.pathname.split('/').filter(Boolean);
    const roomMarker = pathParts.indexOf('rooms');
    const wsMarker = pathParts.indexOf('ws');
    const roomId = pathParts[(roomMarker >= 0 ? roomMarker : wsMarker) + 1] || '';

    if (url.pathname.endsWith('/exists') && request.method === 'GET') {
      const saved = this.game || await this.ctx.storage.get<GameState>('game');
      return Response.json({
        exists: Boolean(saved && (saved.expiresAt || saved.createdAt + ROOM_TTL_MS) > Date.now()),
        createdAt: saved?.createdAt,
      }, { headers: corsHeaders });
    }

    if (this.expired) {
      return Response.json({ message: '房间已过期' }, { status: 410, headers: corsHeaders });
    }

    if (!this.game) {
      await this.loadOrCreate(roomId);
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client, headers: corsHeaders });
    }

    if (url.pathname.endsWith('/state') && request.method === 'GET') {
      return Response.json(this.publicState(), { headers: corsHeaders });
    }

    if (url.pathname.endsWith('/init') && request.method === 'POST') {
      let body: any = {};
      try { body = await request.json(); } catch { /* keep defaults */ }
      const smallBlind = Number(body.smallBlind ?? this.game.smallBlind);
      const bigBlind = Number(body.bigBlind ?? this.game.bigBlind);
      const expiresAt = Number(body.expiresAt ?? this.game.expiresAt);
      if (Number.isInteger(smallBlind) && Number.isInteger(bigBlind) && smallBlind > 0 && bigBlind > smallBlind) {
        this.game.smallBlind = smallBlind;
        this.game.bigBlind = bigBlind;
      }
      if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
        this.game.expiresAt = expiresAt;
      }
      await this.ctx.storage.setAlarm(this.game.expiresAt);
      await this.save();
      return Response.json({
        roomId: this.game.roomId,
        smallBlind: this.game.smallBlind,
        bigBlind: this.game.bigBlind,
        expiresAt: this.game.expiresAt,
      }, { headers: corsHeaders });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }

  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
    await this.ready;
    try {
      const msg: ClientMessage = JSON.parse(message);
      const stateBefore = JSON.stringify(this.game);
      switch (msg.type) {
        case 'join':
          await this.handleJoin(ws, msg.name || '玩家', msg.playerId, msg.deviceId);
          break;
        case 'leave':
          await this.handleLeave(ws);
          break;
        case 'action':
          await this.handleAction(ws, msg.action || 'check', msg.amount);
          break;
        case 'startHand':
          await this.handleStartHand(ws);
          break;
        case 'nextRound':
          await this.handleNextRound(ws);
          break;
        case 'endHand':
          await this.handleEndHand(ws, msg.winnerIds || []);
          break;
        case 'updateSettings':
          await this.handleSettings(ws, msg.settings || {});
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
      }
      if (JSON.stringify(this.game) !== stateBefore) {
        await this.save();
      }
    } catch (e) {
      this.sendError(ws, e instanceof Error ? e.message : '未知错误');
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.ready;
    const playerId = this.playerIdFor(ws);
    if (playerId && this.game) {
      const player = this.game.players.find(p => p.id === playerId);
      this.connections.delete(ws);
      const hasAnotherConnection = this.ctx.getWebSockets().some(socket =>
        socket !== ws && this.playerIdFor(socket) === playerId
      );
      if (player && !hasAnotherConnection) this.markDisconnected(player);
      this.broadcast();
      await this.save();
    }
  }

  async webSocketError(_ws: WebSocket, error: Error): Promise<void> {
    console.error('WebSocket error:', error.message);
  }

  private async handleJoin(
    ws: WebSocket,
    name: string,
    existingPlayerId?: string,
    deviceId?: string,
  ): Promise<void> {
    let player: Player | undefined;

    if (existingPlayerId) {
      const mappedDevice = this.game.playerDevices[existingPlayerId];
      if (!mappedDevice || !deviceId || mappedDevice === deviceId) {
        player = this.game.players.find(p => p.id === existingPlayerId);
      }
    }
    if (!player && deviceId) {
      const matchedPlayerId = Object.keys(this.game.playerDevices).find(
        playerId => this.game.playerDevices[playerId] === deviceId
      );
      if (matchedPlayerId) {
        player = this.game.players.find(p => p.id === matchedPlayerId);
      }
    }
    if (!player && this.game.round === 'waiting') {
      player = this.game.players.find(p => p.name === name && !p.isConnected);
    }

    if (player) {
      player.isConnected = true;
      if (!player.isFolded) player.isActive = true;
      for (const socket of this.ctx.getWebSockets()) {
        if (socket !== ws && this.playerIdFor(socket) === player.id) {
          this.connections.delete(socket);
          try { socket.close(1000, '已在新连接中恢复'); } catch { /* already closed */ }
        }
      }
      this.connections.set(ws, player.id);
      ws.serializeAttachment({ playerId: player.id } satisfies SocketAttachment);
      if (deviceId) this.game.playerDevices[player.id] = deviceId;
      this.game.lastAction = `${player.name} 重新连接`;
    } else {
      if (this.game.round !== 'waiting') {
        this.sendError(ws, '游戏已开始，无法加入');
        return;
      }
      if (this.game.players.length >= 12) {
        this.sendError(ws, '房间已满（最多12人）');
        return;
      }
      const id = crypto.randomUUID();
      player = {
        id,
        name,
        chips: DEFAULT_CHIPS,
        position: this.game.players.length,
        isFolded: false,
        isActive: true,
        isAllIn: false,
        currentBet: 0,
        totalBet: 0,
        hasActedThisRound: false,
        isConnected: true,
      };
      this.game.players.push(player);
      if (deviceId) this.game.playerDevices[id] = deviceId;
      this.connections.set(ws, id);
      ws.serializeAttachment({ playerId: id } satisfies SocketAttachment);
      this.game.lastAction = `${player.name} 加入房间`;
    }

    this.broadcast(player.id);
  }

  private async handleLeave(ws: WebSocket): Promise<void> {
    const playerId = this.playerIdFor(ws);
    if (!playerId) return;

    const player = this.game.players.find(p => p.id === playerId);
    if (player) this.markDisconnected(player);
    this.connections.delete(ws);
    this.broadcast();
  }

  private markDisconnected(player: Player): void {
    player.isConnected = false;
    if (this.game.round === 'waiting') return;

    const playerIndex = this.game.players.indexOf(player);
    const wasCurrentPlayer = this.game.currentPlayerIndex === playerIndex;
    player.isActive = false;
    player.isFolded = true;
    if (wasCurrentPlayer) this.advanceTurn();
  }

  async alarm(): Promise<void> {
    await this.ready;
    if (!this.game) {
      await this.ctx.storage.deleteAll();
      return;
    }

    if (Date.now() < this.game.expiresAt) {
      await this.ctx.storage.setAlarm(this.game.expiresAt);
      return;
    }

    const roomId = this.game.roomId;
    this.expired = true;
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1000, '房间已过期'); } catch { /* already closed */ }
    }
    await this.env.ROOM_REGISTRY.getByName(roomId).remove();
    await this.ctx.storage.deleteAll();
  }

  private async handleAction(ws: WebSocket, action: Action, amount?: number): Promise<void> {
    if (this.game.round === 'waiting' || this.game.round === 'showdown') {
      this.sendError(ws, '当前阶段无法操作');
      return;
    }

    const playerId = this.playerIdFor(ws);
    if (!playerId) { this.sendError(ws, '未加入游戏'); return; }

    const playerIndex = this.game.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) { this.sendError(ws, '玩家不存在'); return; }

    const player = this.game.players[playerIndex];

    if (playerIndex !== this.game.currentPlayerIndex) {
      this.sendError(ws, '还没轮到你操作');
      return;
    }

    if (player.isFolded || player.isAllIn) {
      this.sendError(ws, '你已经无法操作了');
      return;
    }

    const toCall = this.game.currentBet - player.currentBet;

    switch (action) {
      case 'fold': {
        player.isFolded = true;
        this.game.lastAction = `${player.name} 弃牌`;
        break;
      }

      case 'check': {
        if (toCall > 0) {
          this.sendError(ws, `需要跟注 ${toCall} 筹码，不能过牌`);
          return;
        }
        this.game.lastAction = `${player.name} 过牌`;
        break;
      }

      case 'call': {
        if (toCall <= 0) {
          this.sendError(ws, '无需跟注，请选择过牌');
          return;
        }
        const actualCall = Math.min(toCall, player.chips);
        player.chips -= actualCall;
        player.currentBet += actualCall;
        player.totalBet += actualCall;
        this.game.pot += actualCall;
        if (player.chips <= 0) player.isAllIn = true;
        this.game.lastAction = `${player.name} 跟注 ${actualCall}`;
        break;
      }

      case 'raise': {
        const raiseAmount = amount || this.game.bigBlind;
        const totalNeeded = toCall + raiseAmount;

        if (totalNeeded >= player.chips) {
          const allIn = player.chips;
          player.chips = 0;
          player.currentBet += allIn;
          player.totalBet += allIn;
          this.game.pot += allIn;
          player.isAllIn = true;
          if (player.currentBet > this.game.currentBet) {
            this.game.currentBet = player.currentBet;
            this.resetActedFlags(playerIndex);
          }
          this.game.lastAction = `${player.name} All-in ${allIn}`;
        } else {
          if (raiseAmount < this.game.bigBlind && this.game.currentBet > 0) {
            this.sendError(ws, `最小加注额为 ${this.game.bigBlind}`);
            return;
          }
          player.chips -= totalNeeded;
          player.currentBet += totalNeeded;
          player.totalBet += totalNeeded;
          this.game.pot += totalNeeded;
          this.game.currentBet = player.currentBet;
          this.resetActedFlags(playerIndex);
          this.game.lastAction = `${player.name} 加注到 ${player.currentBet}`;
        }
        break;
      }
    }

    player.hasActedThisRound = true;
    this.game.lastActor = player.name;

    const activePlayers = this.game.players.filter(p => !p.isFolded && p.isActive);
    if (activePlayers.length === 1) {
      this.game.round = 'showdown';
      this.awardPot([activePlayers[0].id]);
      this.game.lastAction = `${activePlayers[0].name} 获胜（其余玩家弃牌）`;
      this.broadcast();
      return;
    }

    this.advanceTurn();

    if (this.isRoundComplete()) {
      this.game.lastAction += ' | 本轮下注完成，请点击"下一轮"';
    }

    this.broadcast();
  }

  private resetActedFlags(raiserIndex: number): void {
    this.game.players.forEach((p, i) => {
      if (i !== raiserIndex && !p.isFolded && !p.isAllIn) {
        p.hasActedThisRound = false;
      }
    });
  }

  private advanceTurn(): void {
    const n = this.game.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (this.game.currentPlayerIndex + i) % n;
      const p = this.game.players[idx];
      if (!p.isFolded && p.isActive && !p.isAllIn) {
        this.game.currentPlayerIndex = idx;
        return;
      }
    }
    this.game.currentPlayerIndex = -1;
  }

  private isRoundComplete(): boolean {
    const actionable = this.game.players.filter(
      p => !p.isFolded && p.isActive && !p.isAllIn
    );
    if (actionable.length === 0) return true;
    return actionable.every(
      p => p.hasActedThisRound && p.currentBet === this.game.currentBet
    );
  }

  private async handleNextRound(ws: WebSocket): Promise<void> {
    if (this.game.round === 'waiting' || this.game.round === 'showdown') {
      this.sendError(ws, '当前无法进入下一轮');
      return;
    }
    if (!this.isRoundComplete()) {
      this.sendError(ws, '本轮下注尚未完成');
      return;
    }

    this.game.players.forEach(p => {
      p.currentBet = 0;
      p.hasActedThisRound = false;
    });
    this.game.currentBet = 0;

    switch (this.game.round) {
      case 'preflop': this.game.round = 'flop'; this.game.communityCards = 3; break;
      case 'flop':    this.game.round = 'turn'; this.game.communityCards = 4; break;
      case 'turn':    this.game.round = 'river'; this.game.communityCards = 5; break;
      case 'river':   this.game.round = 'showdown'; break;
    }

    if (this.game.round === 'showdown') {
      this.game.lastAction = '进入摊牌阶段 — 请选择获胜者';
      this.broadcast();
      return;
    }

    this.setFirstToAct();
    this.game.lastAction = `进入【${getRoundName(this.game.round)}】轮`;
    this.broadcast();
  }

  private async handleStartHand(_ws: WebSocket): Promise<void> {
    if (this.game.round !== 'waiting') {
      this.sendToAll('当前手牌尚未结束');
      return;
    }

    this.game.players.forEach(player => {
      player.isActive = player.isConnected && player.chips > 0;
    });
    const connectedPlayers = this.game.players.filter(p => p.isActive);
    if (connectedPlayers.length < 2) {
      this.sendToAll('至少需要 2 名在线且有筹码的玩家才能开始');
      this.broadcast();
      return;
    }

    this.game.handNumber++;
    this.game.lastWinnerIds = [];
    this.game.round = 'preflop';
    this.game.pot = 0;
    this.game.currentBet = 0;
    this.game.communityCards = 0;

    if (this.game.handNumber > 1) {
      this.game.dealerIndex = this.nextActiveIndex(this.game.dealerIndex);
    } else if (!this.game.players[this.game.dealerIndex]?.isActive) {
      this.game.dealerIndex = this.nextActiveIndex(this.game.dealerIndex);
    }

    this.game.players.forEach(p => {
      p.isFolded = false;
      p.isAllIn = false;
      p.currentBet = 0;
      p.totalBet = 0;
      p.hasActedThisRound = false;
      p.position = -1;
    });
    this.assignPositions();

    this.postBlinds();
    this.setFirstToAct();
    this.game.lastAction = `第 ${this.game.handNumber} 手牌开始`;
    this.broadcast();
  }

  private postBlinds(): void {
    const activeCount = this.game.players.filter(player => player.isActive).length;
    if (activeCount < 2) return;

    const sbIdx = activeCount === 2
      ? this.game.dealerIndex
      : this.nextActiveIndex(this.game.dealerIndex);
    const bbIdx = this.nextActiveIndex(sbIdx);

    const sb = this.game.players[sbIdx];
    const sbAmt = Math.min(this.game.smallBlind, sb.chips);
    sb.chips -= sbAmt;
    sb.currentBet = sbAmt;
    sb.totalBet = sbAmt;
    this.game.pot += sbAmt;
    if (sb.chips <= 0) sb.isAllIn = true;

    const bb = this.game.players[bbIdx];
    const bbAmt = Math.min(this.game.bigBlind, bb.chips);
    bb.chips -= bbAmt;
    bb.currentBet = bbAmt;
    bb.totalBet = bbAmt;
    this.game.pot += bbAmt;
    this.game.currentBet = bbAmt;
    if (bb.chips <= 0) bb.isAllIn = true;

    this.game.lastAction = `盲注: SB ${sbAmt} | BB ${bbAmt}`;
  }

  private setFirstToAct(): void {
    const activeCount = this.game.players.filter(player => player.isActive).length;
    if (activeCount < 2) return;

    let startIdx: number;
    if (activeCount === 2) {
      startIdx = this.game.round === 'preflop'
        ? this.game.dealerIndex
        : this.nextActiveIndex(this.game.dealerIndex);
    } else {
      startIdx = this.game.round === 'preflop'
        ? this.nextActiveIndex(this.nextActiveIndex(this.nextActiveIndex(this.game.dealerIndex)))
        : this.nextActiveIndex(this.game.dealerIndex);
    }

    for (let i = 0; i < this.game.players.length; i++) {
      const idx = (startIdx + i) % this.game.players.length;
      if (!this.game.players[idx].isFolded && this.game.players[idx].isActive && !this.game.players[idx].isAllIn) {
        this.game.currentPlayerIndex = idx;
        return;
      }
    }
    this.game.currentPlayerIndex = -1;
  }

  private nextActiveIndex(fromIndex: number): number {
    const count = this.game.players.length;
    if (count === 0) return -1;

    for (let offset = 1; offset <= count; offset++) {
      const index = (fromIndex + offset + count) % count;
      if (this.game.players[index].isActive) return index;
    }
    return -1;
  }

  private assignPositions(): void {
    let index = this.game.dealerIndex;
    let position = 0;
    const activeCount = this.game.players.filter(player => player.isActive).length;
    while (index >= 0 && position < activeCount) {
      this.game.players[index].position = position++;
      index = this.nextActiveIndex(index);
    }
  }

  private normalizeDealerIndex(): void {
    if (this.game.players.length === 0) {
      this.game.dealerIndex = 0;
      return;
    }
    this.game.dealerIndex = Math.min(this.game.dealerIndex, this.game.players.length - 1);
    this.game.players.forEach((player, index) => {
      player.position = (index - this.game.dealerIndex + this.game.players.length) % this.game.players.length;
    });
  }

  private async handleEndHand(_ws: WebSocket, winnerIds: string[]): Promise<void> {
    if (this.game.round !== 'showdown') {
      return;
    }
    if (winnerIds.length === 0) {
      this.sendToAll('请至少选择一位获胜者');
      return;
    }

    this.awardPot(winnerIds);
    this.game.round = 'waiting';
    this.game.lastAction = '手牌结束 — 点击【开始新一手牌】继续';
    this.broadcast();
  }

  private awardPot(winnerIds: string[]): void {
    const pot = this.game.pot;
    if (pot <= 0 || winnerIds.length === 0) return;
    this.game.lastWinnerIds = winnerIds.slice();

    const share = Math.floor(pot / winnerIds.length);
    const remainder = pot - share * winnerIds.length;

    const names: string[] = [];
    for (let i = 0; i < winnerIds.length; i++) {
      const winner = this.game.players.find(p => p.id === winnerIds[i]);
      if (winner) {
        const amt = share + (i === 0 ? remainder : 0);
        winner.chips += amt;
        names.push(winner.name);
      }
    }

    this.game.lastAction = `${names.join('、')} 赢得 ${pot} 筹码`;
    this.game.pot = 0;
  }

  private async handleSettings(_ws: WebSocket, settings: Partial<Pick<GameState, 'smallBlind' | 'bigBlind'>>): Promise<void> {
    if (this.game.round !== 'waiting') {
      this.sendToAll('游戏进行中不能修改盲注');
      return;
    }

    const smallBlind = settings.smallBlind ?? this.game.smallBlind;
    const bigBlind = settings.bigBlind ?? this.game.bigBlind;
    if (!Number.isInteger(smallBlind) || !Number.isInteger(bigBlind) || smallBlind <= 0 || bigBlind <= smallBlind) {
      this.sendToAll('盲注必须为正整数，且大盲必须大于小盲');
      return;
    }
    this.game.smallBlind = smallBlind;
    this.game.bigBlind = bigBlind;
    this.game.lastAction = `盲注调整为 SB ${this.game.smallBlind} / BB ${this.game.bigBlind}`;
    this.broadcast();
  }

  private broadcast(yourPlayerId?: string): void {
    const baseState = this.publicState();
    const socks = this.ctx.getWebSockets();

    for (const ws of socks) {
      try {
        const pid = this.playerIdFor(ws);
        const state: PublicGameState = { ...baseState, yourPlayerId: pid || yourPlayerId };
        ws.send(JSON.stringify({ type: 'state', state }));
      } catch {
        // connection may have closed
      }
    }
  }

  private sendError(ws: WebSocket, message: string): void {
    try { ws.send(JSON.stringify({ type: 'error', message })); } catch { /* ignore */ }
  }

  private sendToAll(message: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(JSON.stringify({ type: 'error', message })); } catch { /* ignore */ }
    }
  }

  private playerIdFor(ws: WebSocket): string | undefined {
    const cached = this.connections.get(ws);
    if (cached) return cached;

    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.playerId) {
      this.connections.set(ws, attachment.playerId);
      return attachment.playerId;
    }
    return undefined;
  }

  private publicState(): PublicGameState {
    return {
      roomId: this.game.roomId,
      players: this.game.players,
      round: this.game.round,
      pot: this.game.pot,
      currentBet: this.game.currentBet,
      dealerIndex: this.game.dealerIndex,
      currentPlayerIndex: this.game.currentPlayerIndex,
      smallBlind: this.game.smallBlind,
      bigBlind: this.game.bigBlind,
      handNumber: this.game.handNumber,
      lastAction: this.game.lastAction,
      lastActor: this.game.lastActor,
      lastWinnerIds: this.game.lastWinnerIds,
      communityCards: this.game.communityCards,
    };
  }
}
