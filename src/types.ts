/**
 * 德州扑克计分器 - 类型定义
 * Texas Hold'em Poker Scorer - Type Definitions
 */

/** 玩家状态 */
export interface Player {
  id: string;
  name: string;
  chips: number;
  /** 相对庄位: 0=Dealer, 1=SB, 2=BB, 3=UTG... */
  position: number;
  isFolded: boolean;
  isActive: boolean;
  isAllIn: boolean;
  /** 断线挂机：仍占座、保盲注位次，但本轮不行动、不付筹码（纯跳过）。
   *  手牌进行中重连仍保持挂机，等下一手发牌才复活。 */
  isSittingOut: boolean;
  /** 当前轮下注额 */
  currentBet: number;
  /** 整手牌总下注额 */
  totalBet: number;
  /** 本轮是否已行动 */
  hasActedThisRound: boolean;
  /** 是否在线 */
  isConnected: boolean;
  /** 最近一次断线时间戳（Date.now()）。在线时为 undefined。
   *  用于前端展示「已离线 N 分钟」，让桌上的人判断是否该移除该占座者。 */
  disconnectedAt?: number;
}

/** 游戏轮次 */
export type Round = 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

/** 玩家操作 */
export type Action = 'fold' | 'check' | 'call' | 'raise';

/** 完整游戏状态（存储在 DO 中） */
export interface GameState {
  roomId: string;
  players: Player[];
  round: Round;
  pot: number;
  /** 当前轮最高下注额 */
  currentBet: number;
  dealerIndex: number;
  currentPlayerIndex: number;
  smallBlind: number;
  bigBlind: number;
  /**
   * 本街最小加注增量（标准 NLHE：开街 = bigBlind；完整加注成功后 = 该次加注额）。
   * 不足额 all-in 不提升此值。
   */
  lastRaiseSize: number;
  handNumber: number;
  lastAction: string;
  /** 最近一手牌的获胜玩家，用于客户端庆祝提示 */
  lastWinnerIds: string[];
  /** 公共牌数量: 0/3/4/5 */
  communityCards: number;
  createdAt: number;
  expiresAt: number;
  /** 私有设备令牌映射，不会发送给客户端 */
  playerDevices: Record<string, string>;
  /** 建房后首个带 deviceId 成功 join 的设备；敏感写操作仅该设备。不下发原始值。 */
  hostDeviceId?: string;
  /** 可选入桌口令（明文，熟人局）；不下发客户端。 */
  joinPassword?: string;
  /** 最近一次结算拆出的主池/边池明细，供前端展示"谁赢了多少"。
   *  仅在 showdown→waiting 转换瞬间有意义，下一手开始时清空。 */
  sidePots?: SidePot[];
}

/** 单个底池层级（主池 / 边池）的结算结果 */
export interface SidePot {
  amount: number;
  winnerIds: string[];
  /** 未跟注筹码/超额投入退还；不应触发赢家庆祝。 */
  refund?: boolean;
}

export interface SettlementPayout {
  playerId: string;
  playerName: string;
  amount: number;
  kind: 'win' | 'refund';
}

export interface SettlementPreview {
  total: number;
  pots: SidePot[];
  payouts: SettlementPayout[];
}

/** 客户端 → 服务端消息 */
export interface ClientMessage {
  type: 'join' | 'leave' | 'action' | 'startHand' | 'nextRound' | 'previewEndHand' | 'endHand' | 'updateSettings' | 'rebuy' | 'removePlayer' | 'sync' | 'ping';
  name?: string;
  playerId?: string;
  deviceId?: string;
  /** 入桌口令（房间设置了 joinPassword 时必填） */
  password?: string;
  action?: Action;
  amount?: number;
  /** 旧字段：单层胜者，向后兼容。服务端会包装成 [[...winnerIds]] 单档。 */
  winnerIds?: string[];
  /** 摊牌按牌力从强到弱的排名分档。
   *  tiers[0] = 第 1 名（可并列），tiers[1] = 第 2 名……
   *  未在任一档位的玩家视为更低名次，不参与争夺边池。 */
  tiers?: string[][];
  settings?: Partial<Pick<GameState, 'smallBlind' | 'bigBlind'>>;
  /** rebuy 目标玩家；省略则为操作者本人 */
  targetPlayerId?: string;
}

/** 服务端 → 客户端消息 */
export interface ServerMessage {
  type: 'state' | 'error' | 'notice' | 'preview' | 'pong';
  state?: PublicGameState;
  message?: string;
  preview?: SettlementPreview;
}

/** 公开的游戏状态（发送给客户端） */
export interface PublicGameState {
  roomId: string;
  players: Player[];
  round: Round;
  pot: number;
  currentBet: number;
  dealerIndex: number;
  currentPlayerIndex: number;
  smallBlind: number;
  bigBlind: number;
  /** 当前最小加注增量（与 lastRaiseSize 一致） */
  minRaise: number;
  handNumber: number;
  lastAction: string;
  lastWinnerIds: string[];
  communityCards: number;
  /** 下注轮是否完成；前端据此显示「下一轮」。 */
  roundComplete: boolean;
  /** 房间 7 天 TTL 的绝对时间戳。 */
  expiresAt: number;
  /** 当前后端构建标识，便于排查客户端缓存。 */
  serverVersion: string;
  /** 当前连接是否为房主（基于 deviceId） */
  youAreHost: boolean;
  /** 房间是否设置了入桌口令（不回传口令本身） */
  requiresPassword: boolean;
  /** 最近一次结算的主池/边池明细（仅结算后短暂存在） */
  sidePots?: SidePot[];
  /** 你的玩家 ID（仅发送给该连接） */
  yourPlayerId?: string;
}

/** 生成房间码（6位，排除易混淆字符） */
export function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

/** 轮次中文名 */
export function getRoundName(round: Round): string {
  const names: Record<Round, string> = {
    waiting: '等待开始',
    preflop: '翻牌前',
    flop: '翻牌',
    turn: '转牌',
    river: '河牌',
    showdown: '摊牌',
  };
  return names[round];
}

/** 获取初始玩家筹码 */
export const DEFAULT_CHIPS = 1000;

/** 默认小盲 */
export const DEFAULT_SMALL_BLIND = 10;

/** 默认大盲 */
export const DEFAULT_BIG_BLIND = 20;

/** 房间创建 7 天后彻底过期 */
export const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 每次生产发布前手动更新；客户端可据此判断是否需要强刷。 */
export const SERVER_VERSION = '2026.07.23.1';
