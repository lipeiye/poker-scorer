import { DurableObject } from 'cloudflare:workers';
import type { Player, Action, GameState, ClientMessage, PublicGameState } from './types';
import { DEFAULT_CHIPS, DEFAULT_SMALL_BLIND, DEFAULT_BIG_BLIND, ROOM_TTL_MS, getRoundName } from './types';
import type { Env } from './env';

interface SocketAttachment {
  playerId?: string;
}

export class GameRoom extends DurableObject<Env> {
  private game!: GameState;
  private connections: Map<WebSocket, string>;
  private expired: boolean;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.connections = new Map();
    this.expired = false;
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get<GameState>('game');

      if (!saved) return;

      this.game = saved;
      this.game.expiresAt ||= this.game.createdAt + ROOM_TTL_MS;
      this.game.playerDevices ||= {};
      this.game.lastWinnerIds ||= [];
      this.game.sidePots = [];
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

      const currentAlarm = await this.ctx.storage.getAlarm();
      // 仅在确实有存档对局时补设闹钟；已销毁（无 game）的房间不重新装弹。
      if (currentAlarm === null && this.game) {
        await this.ctx.storage.setAlarm(this.nextCleanupOrExpiry());
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
        sidePots: [],
      };
      await this.ctx.storage.setAlarm(this.nextCleanupOrExpiry());
    }
  }

  /**
   * 计算从 now 到「下一个北京时间 04:00」的毫秒数。
   * 用 Asia/Shanghai（无 DST）。选凌晨 4 点避开国内熟人局黄金时段（晚间）。
   */
  private nextCleanupMs(now = Date.now()): number {
    const TZ = 'Asia/Shanghai';
    const wallParts = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(now));
    const get = (t: string) => Number(wallParts.find(p => p.type === t)?.value ?? 0);
    const wallHour = get('hour');
    // 当前北京墙钟到今天 4:00 还剩多少毫秒（若已过 4 点则为负）
    const elapsedTodayMs =
      ((wallHour * 60 + get('minute')) * 60 + get('second')) * 1000;
    const fourAmMs = 4 * 60 * 60 * 1000;
    let delta = fourAmMs - elapsedTodayMs;
    if (delta <= 0) delta += 24 * 60 * 60 * 1000;
    return delta;
  }

  /** 取「下一个北京 04:00」与「7 天 TTL 过期」中较早者，作为 alarm 触发时间。 */
  private nextCleanupOrExpiry(now = Date.now()): number {
    const cleanup = now + this.nextCleanupMs(now);
    const expiry = this.game ? this.game.expiresAt : now + ROOM_TTL_MS;
    return Math.max(now + 1_000, Math.min(cleanup, expiry));
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

    // 已被清理/过期的房间：对所有查询一律返回不存在，避免内存里残留的 this.game 误报。
    if (this.expired) {
      if (url.pathname.endsWith('/exists') && request.method === 'GET') {
        return Response.json({ exists: false }, { headers: corsHeaders });
      }
      return Response.json({ message: '房间已过期' }, { status: 410, headers: corsHeaders });
    }

    if (url.pathname.endsWith('/exists') && request.method === 'GET') {
      const saved = this.game || await this.ctx.storage.get<GameState>('game');
      return Response.json({
        exists: Boolean(saved && (saved.expiresAt || saved.createdAt + ROOM_TTL_MS) > Date.now()),
        createdAt: saved?.createdAt,
      }, { headers: corsHeaders });
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
      await this.ctx.storage.setAlarm(this.nextCleanupOrExpiry());
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
          await this.handleEndHand(ws, msg.tiers, msg.winnerIds);
          break;
        case 'updateSettings':
          await this.handleSettings(ws, msg.settings || {});
          break;
        case 'rebuy':
          await this.handleRebuy(ws, msg.amount, msg.targetPlayerId || msg.playerId);
          break;
        case 'removePlayer':
          await this.handleRemovePlayer(ws, msg.targetPlayerId || msg.playerId);
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
      // 手牌进行中重连：保持挂机(isSittingOut)，本手牌仍纯跳过，等下一手发牌才复活。
      // 仅在等待区(waiting)重连才立即清除挂机。
      if (this.game.round === 'waiting') {
        player.isSittingOut = false;
        if (!player.isFolded) player.isActive = true;
      }
      // 先注册新连接，再关闭旧连接：这样旧连接的 webSocketClose 回调里
      // hasAnotherConnection 一定为 true，不会把刚重连的玩家误判离线/挂机。
      this.connections.set(ws, player.id);
      ws.serializeAttachment({ playerId: player.id } satisfies SocketAttachment);
      for (const socket of this.ctx.getWebSockets()) {
        if (socket !== ws && this.playerIdFor(socket) === player.id) {
          this.connections.delete(socket);
          try { socket.close(1000, '已在新连接中恢复'); } catch { /* already closed */ }
        }
      }
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
        isSittingOut: false,
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

    // 手牌进行中断线：改为「坐出挂机」——保持座位、盲注位次与底池权益不变，
    // 不 fold、不出局、不消耗筹码。轮到他时由 advanceTurn 自动纯跳过。
    // 本手牌内重连仍保持挂机，等下一手发牌（handleStartHand）才复活。
    player.isSittingOut = true;

    // 若断线者正是当前行动者，把行动权交给下一位可行动者。
    const playerIndex = this.game.players.indexOf(player);
    if (this.game.currentPlayerIndex === playerIndex) {
      this.advanceTurn();
    }

    // 检查是否仅剩一人争夺底池（断线不改变争夺者集合，但需兜底）。
    this.checkSoloSurvivor();
  }

  /** 检查是否只剩一个争夺者，若是则直接 award + 进入 showdown */
  private checkSoloSurvivor(): void {
    const contesting = this.game.players.filter(p => !p.isFolded);
    if (contesting.length === 1) {
      this.awardToSoloSurvivor(contesting[0].id, '其余玩家弃牌/断线');
    }
  }

  private awardToSoloSurvivor(winnerId: string, reason: string): void {
    const winner = this.game.players.find(p => p.id === winnerId);
    this.game.round = 'showdown';
    const result = this.awardPotsByTiers([[winnerId]]);
    if (!result.ok) {
      // 单人独胜理论上必成功；若失败仍保持 showdown 并提示
      this.game.lastAction = result.message;
      this.broadcast();
      return;
    }
    this.game.round = 'waiting';
    this.game.lastAction = `${winner?.name || '未知'} 获胜（${reason}）`;
    this.broadcast();
  }

  async alarm(): Promise<void> {
    await this.ready;
    if (!this.game) {
      await this.ctx.storage.deleteAll();
      return;
    }

    const now = Date.now();
    const ttlExpired = now >= this.game.expiresAt;

    // 手牌进行中：绝不销毁，延后 15 分钟再检查（或等到 TTL）。
    // 避免北京时间晚间牌局被每日清理误杀。
    if (!ttlExpired && this.game.round !== 'waiting') {
      const retryAt = Math.min(now + 15 * 60 * 1000, this.game.expiresAt);
      await this.ctx.storage.setAlarm(Math.max(now + 1_000, retryAt));
      return;
    }

    // waiting 下的每日清理，或 7 天 TTL 到期：销毁房间。
    const roomId = this.game.roomId;
    this.expired = true;
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1000, '房间已清理'); } catch { /* already closed */ }
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
        const raiseAmount = Math.max(1, amount || this.game.bigBlind);
        const totalNeeded = toCall + raiseAmount;

        if (totalNeeded >= player.chips) {
          const allIn = player.chips;
          const prevBet = this.game.currentBet;
          player.chips = 0;
          player.currentBet += allIn;
          player.totalBet += allIn;
          this.game.pot += allIn;
          player.isAllIn = true;
          if (player.currentBet > this.game.currentBet) {
            const raiseSize = player.currentBet - prevBet;
            this.game.currentBet = player.currentBet;
            // 不足额 all-in（加注幅度 < 大盲）不完整重开行动：已行动者只需补跟，不可再加注重开。
            // 通过不 reset 标志实现；isRoundComplete 仍要求 currentBet 对齐，故未跟满者仍会被轮到。
            if (raiseSize >= this.game.bigBlind) {
              this.resetActedFlags(playerIndex);
            }
          }
          this.game.lastAction = `${player.name} All-in ${allIn}`;
        } else {
          // 无条件 enforce 最低下注/加注额 >= bigBlind
          if (raiseAmount < this.game.bigBlind) {
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

    // 仍在争夺底池的玩家 = 未弃牌（断线挂机者仍占座、仍争夺，不算退出）。
    // 只有真正 fold 才算退出争夺，避免"一人断线→另一人直接赢"。
    const contestingPlayers = this.game.players.filter(p => !p.isFolded);
    if (contestingPlayers.length === 1) {
      this.awardToSoloSurvivor(contestingPlayers[0].id, '其余玩家弃牌');
      return;
    }

    this.advanceTurn();

    // 无人能再形成有效对峙（全员 all-in / 仅一人可行动）→ 直接摊牌，无需逐街 check。
    if (this.isRoundComplete() && this.shouldRunOutBoard()) {
      await this.autoAdvanceToShowdown();
      return;
    }

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
      if (!p.isFolded && p.isActive && !p.isAllIn && !p.isSittingOut) {
        this.game.currentPlayerIndex = idx;
        return;
      }
    }
    this.game.currentPlayerIndex = -1;
  }

  private isRoundComplete(): boolean {
    const actionable = this.game.players.filter(
      p => !p.isFolded && p.isActive && !p.isAllIn && !p.isSittingOut
    );
    if (actionable.length === 0) return true;
    return actionable.every(
      p => p.hasActedThisRound && p.currentBet === this.game.currentBet
    );
  }

  /**
   * 后续街道无法再形成有效对峙时直接跑牌：
   * - 可行动人数为 0（全员 all-in / 挂机）
   * - 可行动人数为 1（其余 all-in 或挂机，下注无人回应）
   * 线下会直接发完公共牌；计分器跳过无意义的逐街 check。
   */
  private shouldRunOutBoard(): boolean {
    const contesting = this.game.players.filter(p => !p.isFolded);
    if (contesting.length < 2) return false;
    const actionable = contesting.filter(
      p => p.isActive && !p.isAllIn && !p.isSittingOut
    );
    return actionable.length <= 1;
  }

  /** 跳过中间街道，直接进入摊牌 */
  private async autoAdvanceToShowdown(): Promise<void> {
    this.game.communityCards = 5;
    this.game.players.forEach(p => {
      p.currentBet = 0;
      p.hasActedThisRound = false;
    });
    this.game.currentBet = 0;
    this.game.round = 'showdown';
    this.game.lastAction = '无人可再加注，直接进入摊牌 — 请选择获胜者';
    this.broadcast();
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

    // 进入下一街前若已无人能再对峙，直接摊牌
    if (this.shouldRunOutBoard()) {
      await this.autoAdvanceToShowdown();
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

    // 新街道开始时再次检测（例如仅一人有筹码）
    if (this.shouldRunOutBoard()) {
      await this.autoAdvanceToShowdown();
      return;
    }

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
    this.game.sidePots = [];
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
      // 下一手开始：在线者清除挂机并参与；离线者继续挂机占座、纯跳过。
      p.isSittingOut = !p.isConnected;
    });
    this.assignPositions();

    this.postBlinds();
    this.setFirstToAct();
    this.game.lastAction = `第 ${this.game.handNumber} 手牌开始`;

    // 盲注后若已无人可再行动（例如全员短码 all-in），直接摊牌
    if (this.isRoundComplete() && this.shouldRunOutBoard()) {
      await this.autoAdvanceToShowdown();
      return;
    }
    this.broadcast();
  }

  private postBlinds(): void {
    const activeCount = this.game.players.filter(player => player.isActive).length;
    if (activeCount < 2) return;

    const sbIdx = activeCount === 2
      ? this.game.dealerIndex
      : this.nextActiveIndex(this.game.dealerIndex);
    let bbIdx = this.nextActiveIndex(sbIdx);

    // 防御：并发重连曾导致 isActive 状态瞬时错乱，使 nextActiveIndex 两次
    // 返回同一玩家，于是 SB 与 BB 压在一个人身上。这里强制 SB≠BB。
    if (bbIdx === sbIdx || bbIdx === -1) {
      bbIdx = this.nextDifferentActiveIndex(sbIdx, sbIdx);
    }
    if (bbIdx === -1 || bbIdx === sbIdx) return;

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
    // currentBet = 实际最高已下注（BB 短码时为 bbAmt，而非名义 bigBlind）。
    // 跟注只需对齐最高有效下注；最小加注幅度仍用 bigBlind 约束。
    this.game.currentBet = Math.max(sbAmt, bbAmt);
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
      if (!this.game.players[idx].isFolded && this.game.players[idx].isActive && !this.game.players[idx].isAllIn && !this.game.players[idx].isSittingOut) {
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

  /**
   * 从 fromIndex 之后找下一个活跃、且不等于 excludeIndex 的玩家下标。
   * 用于并发重连导致状态错乱时的盲注兜底，保证 SB≠BB。
   */
  private nextDifferentActiveIndex(fromIndex: number, excludeIndex: number): number {
    const count = this.game.players.length;
    if (count === 0) return -1;

    for (let offset = 1; offset <= count; offset++) {
      const index = (fromIndex + offset + count) % count;
      if (index === excludeIndex) continue;
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

  private async handleEndHand(_ws: WebSocket, tiers: string[][] | undefined, winnerIds: string[] | undefined): Promise<void> {
    if (this.game.round !== 'showdown') {
      this.sendToAll('当前不在摊牌阶段');
      return;
    }

    // 统一成排名分档：tiers 优先；旧客户端只发 winnerIds 时包装成单层（第 1 名并列）。
    let normalized: string[][];
    if (tiers && tiers.length > 0) {
      normalized = tiers.filter(t => Array.isArray(t) && t.length > 0);
    } else if (winnerIds && winnerIds.length > 0) {
      normalized = [winnerIds];
    } else {
      this.sendToAll('请至少选择一位获胜者');
      return;
    }
    if (normalized.length === 0) {
      this.sendToAll('请至少选择一位获胜者');
      return;
    }

    // 校验：所有 id 必须存在、未弃牌、且不在多个档位重复。
    const seen = new Set<string>();
    for (const tier of normalized) {
      for (const id of tier) {
        if (seen.has(id)) {
          this.sendToAll('同一玩家不能出现在多个名次档位');
          return;
        }
        seen.add(id);
        const p = this.game.players.find(pp => pp.id === id);
        if (!p || p.isFolded) {
          this.sendToAll('所选胜者无效');
          return;
        }
      }
    }

    const result = this.awardPotsByTiers(normalized);
    if (!result.ok) {
      this.sendToAll(result.message);
      return;
    }
    this.game.round = 'waiting';
    // 保留边池分配明细，附带下一手提示
    this.game.lastAction = `${this.game.lastAction} — 点击【开始新一手牌】继续`;
    this.broadcast();
  }

  /**
   * 按排名分档结算主池/边池。
   *
   * tiers[i] = 第 (i+1) 名（可并列）。牌力从强到弱。
   * 算法：按 totalBet 分层；每层由投入达标的未弃牌玩家争夺。
   *
   * 筹码守恒保证：
   * 1. 某层无未弃牌合格者 → 退还该层贡献者（uncalled / 弃牌后超额）。
   * 2. 某层仅 1 名合格者且 tiers 未覆盖 → 自动归该人（未跟注退还或独占边池）。
   * 3. 某层 ≥2 名合格者且 tiers 未覆盖任何人 → 拒绝结算，要求继续选名次。
   */
  private awardPotsByTiers(tiers: string[][]): { ok: true } | { ok: false; message: string } {
    const players = this.game.players;
    const contributors = players.filter(p => p.totalBet > 0);
    if (contributors.length === 0 || this.game.pot <= 0) return { ok: true };

    const levelSet = new Set<number>();
    for (const p of contributors) levelSet.add(p.totalBet);
    const levels = Array.from(levelSet).sort((a, b) => a - b);

    type LayerPlan = {
      potTotal: number;
      winningIds: string[];
      refund?: boolean;
    };
    const plans: LayerPlan[] = [];
    let prevLevel = 0;

    for (const level of levels) {
      const layerAmount = level - prevLevel;
      prevLevel = level;
      if (layerAmount <= 0) continue;

      const contributorsAtLayer = contributors.filter(p => p.totalBet >= level);
      const potTotal = layerAmount * contributorsAtLayer.length;
      if (potTotal <= 0) continue;

      const eligible = contributorsAtLayer.filter(p => !p.isFolded);
      const eligibleIds = new Set(eligible.map(p => p.id));

      // 无人有资格：退还该层全部贡献者（典型：超额加注后全弃，或仅弃牌者留在更高层）
      if (eligibleIds.size === 0) {
        plans.push({
          potTotal,
          winningIds: contributorsAtLayer.map(p => p.id),
          refund: true,
        });
        continue;
      }

      let winningIds: string[] = [];
      for (const tier of tiers) {
        const matched = tier.filter(id => eligibleIds.has(id));
        if (matched.length > 0) {
          winningIds = matched;
          break;
        }
      }

      // tiers 未覆盖该层：单人合格 → 自动归其（未跟注退还）；多人 → 要求补排名
      if (winningIds.length === 0) {
        if (eligibleIds.size === 1) {
          winningIds = [eligible[0].id];
        } else {
          const names = eligible.map(p => p.name).join('、');
          return {
            ok: false,
            message: `边池尚未排完名次，请继续选择（涉及：${names}）`,
          };
        }
      }

      plans.push({ potTotal, winningIds });
    }

    // 两阶段：先规划成功，再动筹码，避免半结算。
    const pots: { amount: number; winnerIds: string[] }[] = [];
    const winnerNames: string[] = [];
    const allWinnerIds = new Set<string>();
    const potBefore = this.game.pot;

    for (const plan of plans) {
      const share = Math.floor(plan.potTotal / plan.winningIds.length);
      const remainder = plan.potTotal - share * plan.winningIds.length;
      for (let i = 0; i < plan.winningIds.length; i++) {
        const winner = players.find(p => p.id === plan.winningIds[i]);
        if (winner) {
          winner.chips += share + (i === 0 ? remainder : 0);
          allWinnerIds.add(winner.id);
          if (!winnerNames.includes(winner.name)) winnerNames.push(winner.name);
        }
      }
      pots.push({ amount: plan.potTotal, winnerIds: plan.winningIds.slice() });
    }

    this.game.lastWinnerIds = Array.from(allWinnerIds);
    this.game.sidePots = pots;
    const breakdown = pots.map(p => {
      const names = p.winnerIds
        .map(id => players.find(pp => pp.id === id)?.name || '?')
        .join('、');
      return `${names} ${p.amount}`;
    }).join(' | ');
    this.game.lastAction = pots.length > 1
      ? `${breakdown}（已按主池/边池结算）`
      : `${winnerNames.join('、')} 赢得 ${potBefore} 筹码`;
    this.game.pot = 0;
    return { ok: true };
  }

  /** 等待阶段补码（默认 +DEFAULT_CHIPS） */
  private async handleRebuy(
    ws: WebSocket,
    amount?: number,
    targetPlayerId?: string,
  ): Promise<void> {
    if (this.game.round !== 'waiting') {
      this.sendError(ws, '仅在等待开始时可以补码');
      return;
    }
    const actorId = this.playerIdFor(ws);
    if (!actorId) {
      this.sendError(ws, '未加入游戏');
      return;
    }
    const targetId = targetPlayerId || actorId;
    const player = this.game.players.find(p => p.id === targetId);
    if (!player) {
      this.sendError(ws, '玩家不存在');
      return;
    }
    const add = amount != null && Number.isInteger(amount) && amount > 0
      ? amount
      : DEFAULT_CHIPS;
    if (add > 100_000) {
      this.sendError(ws, '单次补码不能超过 100000');
      return;
    }
    player.chips += add;
    this.game.lastAction = `${player.name} 补码 +${add}（现有 ${player.chips}）`;
    this.broadcast();
  }

  /** 等待阶段移除离线玩家，释放座位 */
  private async handleRemovePlayer(ws: WebSocket, targetPlayerId?: string): Promise<void> {
    if (this.game.round !== 'waiting') {
      this.sendError(ws, '仅在等待开始时可以移除玩家');
      return;
    }
    if (!targetPlayerId) {
      this.sendError(ws, '请指定要移除的玩家');
      return;
    }
    const actorId = this.playerIdFor(ws);
    if (!actorId) {
      this.sendError(ws, '未加入游戏');
      return;
    }
    const idx = this.game.players.findIndex(p => p.id === targetPlayerId);
    if (idx < 0) {
      this.sendError(ws, '玩家不存在');
      return;
    }
    const player = this.game.players[idx];
    if (player.isConnected) {
      this.sendError(ws, '只能移除离线玩家');
      return;
    }
    const name = player.name;
    this.game.players.splice(idx, 1);
    delete this.game.playerDevices[targetPlayerId];
    if (this.game.players.length === 0) {
      this.game.dealerIndex = 0;
    } else if (idx < this.game.dealerIndex) {
      this.game.dealerIndex--;
    } else if (this.game.dealerIndex >= this.game.players.length) {
      this.game.dealerIndex = 0;
    }
    this.game.lastAction = `${name} 已移出房间`;
    this.broadcast();
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
      sidePots: this.game.sidePots,
    };
  }
}
