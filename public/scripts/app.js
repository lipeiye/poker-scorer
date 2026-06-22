// 应用入口：粘合所有模块。负责状态流转、消息路由、庆祝弹窗、连接联动、SW 注册。
// 不持有复杂逻辑，只把 socket 的消息分发给 render / feedback / ui。
import { $, toast, showView, showModal, closeModal, closeTopModal, renderConnDot, applyDeepLink, installKeyboardAdapter } from './ui.js';
import { connect, disconnect, send, onMessage, onConn, isConnected, getMyPlayerId, setMyPlayerId, persistIdentity, getCurrentRoomId, getCurrentName } from './socket.js';
import { deviceId, getSavedPlayer } from './storage.js';
import { render, renderActionBar, isRoundComplete, clearSelectedWinners } from './render.js';
import { sendAction, onFoldClick, doRaise, showRaise, adjustRaise, onToggleWinner, confirmWinners, startHand, nextRound, updateSettings, vibrate } from './actions.js';
import { notifyMyTurn, unlockAudio } from './feedback.js';

// 应用级状态
let state = null;
let myPlayerId = getMyPlayerId() || deviceId();
let hostSharePending = false;

// ---------- 初始化 ----------
applyDeepLink();           // M6: 深链预填
installKeyboardAdapter();  // M13/M15: iOS/Android 键盘适配（操作栏 + 输入框）
registerServiceWorker();   // M14: SW 缓存首屏

// 用户首次交互解锁音频（浏览器自动播放策略要求）
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, unlockAudio, { once: true });
}

// 顶栏连接状态点联动（M11）
onConn((connState) => {
  renderConnDot(connState);
  // 只有断线后重连才提示；首次进入房间的 connecting 属于正常建连，不打扰
  if (connState === 'connecting' && state) toast('正在重连…', 1500);
});

// 服务端消息分发
onMessage((msg) => {
  if (msg.type === 'state') {
    onState(msg.state);
  } else if (msg.type === 'error') {
    toast(msg.message, 2000);
  } else if (msg.type === '_disconnected') {
    onDisconnected();
  }
});

// 全局键盘：ESC 关闭最上层 modal
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTopModal();
});

// M16: 生命周期管理
// pagehide persisted=true 时页面进入后台/bfcache，不要主动断开，切回前台由 socket.js 自动恢复；
// persisted=false 时才是真正关闭/导航，才主动断开。
window.addEventListener('pagehide', (e) => {
  if (!e.persisted) disconnect();
});

// 把按钮处理函数挂到 window，供 index.html 内联 onclick 调用（保持 HTML 简单）
Object.assign(window, {
  createRoom, joinRoom, leaveTable,
  copyCurrentRoomCode, shareCurrentRoom,
  openNameModal, closeNameModal, submitName,
  closeShareModal, closeWinnerModal,
  startHand, nextRound, updateSettings,
  showRaise: () => state && showRaise(state, myPlayerId),
  adjustRaise: (d) => state && adjustRaise(d, state, myPlayerId),
  doRaise, onFoldClick,
});

// ---------- 状态处理 ----------
function onState(s) {
  const prev = state;
  state = s;
  if (s.yourPlayerId) {
    myPlayerId = s.yourPlayerId;
    setMyPlayerId(s.yourPlayerId);
    persistIdentity(getCurrentRoomId(), s.yourPlayerId, getCurrentName());
  }
  render(s, myPlayerId);
  renderActionBar(s, myPlayerId, actionHandlers());
  maybeShowWinnerCelebration(s);
  notifyMyTurnIfNeeded(s, prev);
  if (hostSharePending) {
    hostSharePending = false;
    const codeEl = document.getElementById('share-code');
    if (codeEl) codeEl.textContent = getCurrentRoomId() || s.roomId;
    setTimeout(() => showModal('share-modal'), 180);
  }
}

function onDisconnected() {
  // 游戏进行中掉线提示用户；socket.js 会自动按退避策略重连。
  // 大厅阶段掉线则由页面可见性切回时自动恢复，无需提示。
  if (state && state.round !== 'waiting') {
    toast('连接断开，正在重连…', 2500);
  }
}

function notifyMyTurnIfNeeded(s, prev) {
  const me = s.players.find((p) => p.id === myPlayerId);
  const myIdx = s.players.findIndex((p) => p.id === myPlayerId);
  const isMyTurn = s.currentPlayerIndex === myIdx && me && !me.isFolded && !me.isAllIn
    && s.round !== 'showdown' && s.round !== 'waiting';
  notifyMyTurn(isMyTurn, document.visibilityState === 'visible');
}

function maybeShowWinnerCelebration(s) {
  if (!s.lastWinnerIds || s.lastWinnerIds.indexOf(myPlayerId) === -1) return;
  const key = s.roomId + ':' + s.handNumber + ':' + myPlayerId;
  if (sessionStorage.getItem('pk_celebrated_win') === key) return;
  sessionStorage.setItem('pk_celebrated_win', key);
  setTimeout(() => showModal('winner-modal'), 180);
}

/** 给 renderActionBar 的操作回调集合 */
function actionHandlers() {
  return {
    onFold: onFoldClick,
    onCheck: () => sendAction('check'),
    onCall: () => sendAction('call'),
    onShowRaise: () => showRaise(state, myPlayerId),
    onNextRound: nextRound,
    onToggleWinner: (id) => onToggleWinner(id, () => {
      if (state) renderActionBar(state, myPlayerId, actionHandlers());
    }),
    onConfirmWinners: confirmWinners,
  };
}

// ---------- 首页入口 ----------
function createRoom() {
  openNameModal({ type: 'create' });
}

async function joinRoom() {
  const code = ($('#join-code').value || '').trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
    toast('房间码不存在，请检查后重试', 2400);
    return;
  }
  try {
    const res = await fetch('/api/rooms/' + encodeURIComponent(code) + '/exists');
    if (res.status === 404) { toast('房间码不存在或已过期', 2600); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (e) {
    toast('暂时无法检查房间，请稍后重试', 2600);
    return;
  }
  const saved = getSavedPlayer(code);
  if (saved && saved.name) {
    toast('正在恢复你的玩家身份…');
    connectRoom(code, saved.name, false);
    return;
  }
  openNameModal({ type: 'join', roomId: code });
}

// ---------- 名字 modal ----------
let pendingNameAction = null;

function openNameModal(action) {
  pendingNameAction = action;
  const input = $('#player-name-input');
  input.value = '';
  $('#name-error').textContent = '';
  showModal('name-modal');
  setTimeout(() => input.focus(), 120);
}

function closeNameModal() {
  pendingNameAction = null;
  closeModal('name-modal');
  $('#name-error').textContent = '';
}

function submitName(event) {
  event.preventDefault();
  const input = $('#player-name-input');
  const name = input.value.trim();
  if (!name) {
    $('#name-error').textContent = '请输入一个名字';
    input.focus();
    return;
  }
  const action = pendingNameAction;
  closeNameModal();
  if (!action) return;
  if (action.type === 'create') {
    createRoomWithName(name);
  } else if (action.type === 'join') {
    connectRoom(action.roomId, name, false);
  }
}

async function createRoomWithName(name) {
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smallBlind: 10, bigBlind: 20 }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.roomId) throw new Error('no roomId');
    connectRoom(data.roomId, name, true);
  } catch (e) {
    toast('创建失败: ' + e.message, 3000);
  }
}

// ---------- 连接 ----------
function connectRoom(roomId, name, isHost) {
  hostSharePending = Boolean(isHost);
  connect(roomId, name);
}

function leaveTable() {
  disconnect();
  closeModal('share-modal');
  const ab = $('#action-bar');
  if (ab) ab.classList.remove('visible');
  state = null;
  clearSelectedWinners();
  showView('home');
}

// ---------- 分享 / 复制 ----------
function closeShareModal() { closeModal('share-modal'); }
function closeWinnerModal() { closeModal('winner-modal'); }

async function copyCurrentRoomCode() {
  const code = getCurrentRoomId() || (state && state.roomId);
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
  } catch {
    const input = document.createElement('textarea');
    input.value = code;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  closeModal('share-modal');
  toast('房间码 ' + code + ' 已复制', 2200);
}

// M6: 分享带深链，朋友点开直接预填房间码
async function shareCurrentRoom() {
  const code = getCurrentRoomId() || (state && state.roomId);
  if (!code) return;
  if (navigator.share) {
    try {
      await navigator.share({
        title: '加入我的德扑牌桌',
        text: '房间码：' + code,
        url: location.origin + '/?room=' + code,
      });
      closeModal('share-modal');
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  await copyCurrentRoomCode();
}

// ---------- Service Worker 注册（M14） ----------
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 静默失败，不影响游戏 */ });
  });
}
