// WebSocket 连接管理：建连、join、断线重连、连接状态广播、心跳保活。
// 不直接碰 DOM（状态展示由 ui.js 订阅 onConn 完成），只对外暴露 send/事件。
import { deviceId, getSavedPlayer, savePlayer } from './storage.js';

/** @typedef {'connected'|'connecting'|'offline'} ConnState */

// ---------- 常量 ----------
const PING_INTERVAL = 15000;   // 15s 发一次 ping
const PONG_TIMEOUT = 10000;    // 10s 内没收到 pong 认为连接假死
const MAX_RECONNECT_DELAY = 30000; // 最大退避 30s

// 单例状态（本应用同一时刻只有一个房间连接，用模块级变量即可）
let ws = null;
let reconnectTimer = null;
let currentRoomId = '';
let currentName = '';
let intentionalClose = false;
/** @type {ConnState} */
let connState = 'offline';
let lastMyPlayerId = '';
let reconnectAttempt = 0;

// 心跳定时器
let pingTimer = null;
let pongTimer = null;

const connListeners = new Set();
const msgListeners = new Set();

// ---------- 生命周期订阅 ----------

/** 通知所有订阅者连接状态变化 */
function setConn(state) {
  connState = state;
  for (const fn of connListeners) fn(state);
}

/** 订阅连接状态。返回取消订阅函数。 */
export function onConn(fn) {
  connListeners.add(fn);
  fn(connState);
  return () => connListeners.delete(fn);
}

/** 订阅服务端消息（state/error/pong/_disconnected）。返回取消订阅函数。 */
export function onMessage(fn) {
  msgListeners.add(fn);
  return () => msgListeners.delete(fn);
}

// ---------- 连接状态查询 ----------

export function isConnected() {
  return ws && ws.readyState === WebSocket.OPEN;
}

export function getMyPlayerId() {
  return lastMyPlayerId;
}

export function setMyPlayerId(id) {
  lastMyPlayerId = id;
}

// ---------- 建连 / 重连 ----------

/** 建立/重建 WebSocket。hostSharePending 由 app 层管理，这里只负责连接本身。 */
export function connect(roomId, name) {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  clearReconnect();
  intentionalClose = false;
  currentRoomId = roomId;
  currentName = name;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  setConn('connecting');
  ws = new WebSocket(proto + '//' + location.host + '/ws/' + roomId);

  ws.onopen = () => {
    setConn('connected');
    reconnectAttempt = 0; // 成功连接后重置退避
    setupHeartbeat();
    const saved = getSavedPlayer(roomId);
    send({
      type: 'join',
      name: name,
      playerId: saved ? saved.playerId : undefined,
      deviceId: deviceId(),
    });
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    // 心跳响应
    if (msg.type === 'pong') {
      clearTimeout(pongTimer);
      return;
    }
    for (const fn of msgListeners) fn(msg);
  };

  ws.onclose = () => {
    stopHeartbeat();
    setConn('offline');
    // 大厅阶段断线直接回首页（由 app 层订阅 onConn 完成）；游戏中才自动重连。
    // onclose 的进一步处理由 app 层订阅 onConn/_disconnected 完成。
    if (!intentionalClose) {
      for (const fn of msgListeners) fn({ type: '_disconnected' });
      scheduleReconnect();
    }
  };

  ws.onerror = () => { /* close 会随后触发，统一在 onclose 处理 */ };
}

/** 立即尝试重连（供 app 层在页面从后台切回时调用）。 */
export function reconnectNow() {
  if (intentionalClose || !currentRoomId || isConnected()) return;
  clearReconnect();
  connect(currentRoomId, currentName);
}

/** 主动断开（用户离开）。不触发重连。 */
export function disconnect() {
  intentionalClose = true;
  clearReconnect();
  if (ws && ws.readyState === WebSocket.OPEN) {
    send({ type: 'leave' });
    setTimeout(() => { if (ws) ws.close(); }, 80);
  } else if (ws) {
    ws.close();
  }
  ws = null;
  stopHeartbeat();
  setConn('offline');
}

/** 发送消息。 */
export function send(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

// ---------- 重连调度（指数退避） ----------

/** 游戏中自动重连。 */
export function scheduleReconnect() {
  if (intentionalClose || reconnectTimer || !currentRoomId) return;
  reconnectAttempt++;
  const delay = Math.min(2000 * Math.pow(2, reconnectAttempt - 1), MAX_RECONNECT_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!intentionalClose && currentRoomId) connect(currentRoomId, currentName);
  }, delay);
}

function clearReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

// ---------- 心跳保活 ----------

function setupHeartbeat() {
  stopHeartbeat();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      send({ type: 'ping' });
      pongTimer = setTimeout(() => {
        // 超时未收到 pong：主动关闭让 onclose 走重连流程
        try { ws.close(); } catch { /* ignore */ }
      }, PONG_TIMEOUT);
    }
  }, PING_INTERVAL);
}

function stopHeartbeat() {
  clearInterval(pingTimer);
  clearTimeout(pongTimer);
  pingTimer = null;
  pongTimer = null;
}

// ---------- 页面可见性：切回前台时立即重连 ----------

if (typeof document !== 'undefined') {
  // 切回前台立即重连
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentRoomId && !intentionalClose && !isConnected()) {
      reconnectNow();
    }
  });
  // 从 bfcache 恢复时 WebSocket 通常已死，立即重连
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && currentRoomId && !intentionalClose && !isConnected()) {
      reconnectNow();
    }
  });
}

// ---------- 查询 ----------

export function getCurrentRoomId() {
  return currentRoomId;
}

export function getCurrentName() {
  return currentName;
}

// 持久化身份（state 收到 yourPlayerId 时调用）
export function persistIdentity(roomId, playerId, name) {
  savePlayer(roomId, playerId, name);
  lastMyPlayerId = playerId;
}
