// 渲染层：根据后端 state 渲染大厅 / 游戏界面 / 摊牌 / 庆祝。
// 只读 state、只写 DOM，不直接发消息（操作由 actions.js 触发）。
import { $, esc, showView } from './ui.js?v=2';

let selectedWinners = new Set();

export function clearSelectedWinners() {
  selectedWinners.clear();
}

export function toggleWinner(id, rerender) {
  if (selectedWinners.has(id)) selectedWinners.delete(id);
  else selectedWinners.add(id);
  if (rerender) rerender();
}

export function getSelectedWinners() {
  return Array.from(selectedWinners);
}

/** 主渲染入口：按 round 切换视图 */
export function render(state, myPlayerId) {
  if (!state) return;
  if (state.round === 'waiting') {
    renderLobby(state, myPlayerId);
    showView('lobby');
  } else {
    renderGame(state, myPlayerId);
    showView('game');
  }
}

// ---------- M10: 底池数字滚动动画 ----------
let potAnimReq = 0;
function animatePot(target) {
  const el = $('#pot-amount');
  if (!el) return;
  const from = parseInt(el.textContent) || 0;
  if (from === target) { el.textContent = target; return; }
  cancelAnimationFrame(potAnimReq);
  const start = performance.now();
  const dur = 280;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    // easeOutCubic
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(from + (target - from) * eased);
    if (t < 1) potAnimReq = requestAnimationFrame(step);
  };
  potAnimReq = requestAnimationFrame(step);
}

// ---------- 大厅 ----------
function renderLobby(state, myPlayerId) {
  $('#lobby-code').textContent = state.roomId;
  const connected = state.players.filter((p) => p.isConnected).length;
  $('#lobby-count').textContent = connected + ' 在线';
  $('#set-sb').value = state.smallBlind;
  $('#set-bb').value = state.bigBlind;
  renderLeaderboard('lobby-leaderboard', state, myPlayerId);

  const me = state.players.find((p) => p.id === myPlayerId);
  $('#btn-start').style.display = me ? '' : 'none';

  let html = '';
  for (const p of state.players) {
    html += '<div class="player-item' + (p.id === myPlayerId ? ' is-you' : '') + '" data-initial="' + esc((p.name || '?').charAt(0)) + '">';
    html += '<span class="player-name">' + esc(p.name) + (p.id === myPlayerId ? ' <span class="text-xs text-dim">(你)</span>' : '') + (!p.isConnected ? ' <span class="player-tag tag-offline">离线</span>' : '') + '</span>';
    html += '<span class="player-chips">' + p.chips + '</span>';
    html += '</div>';
  }
  $('#lobby-players').innerHTML = html;
}

// ---------- 游戏 ----------
const ROUND_NAMES = { waiting: '等待', preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌' };

function renderGame(state, myPlayerId) {
  $('#game-code').textContent = state.roomId;
  $('#game-hand').textContent = state.handNumber > 0 ? '第' + state.handNumber + '手' : '';
  $('#round-bar').innerHTML = '<span class="round-name">' + (ROUND_NAMES[state.round] || state.round) + '</span>';

  let cards = '';
  for (let i = 0; i < 5; i++) {
    cards += '<div class="card-slot' + (i < state.communityCards ? ' dealt' : '') + '">' + (i < state.communityCards ? '🂠' : '') + '</div>';
  }
  $('#community-cards').innerHTML = cards;

  animatePot(state.pot);
  renderLeaderboard('game-leaderboard', state, myPlayerId);

  const n = state.players.length;
  const dealerIdx = state.dealerIndex;
  const activeIndexes = state.players.map((p, i) => (p.isActive ? i : -1)).filter((i) => i >= 0);
  const nextActive = (from) => {
    if (!activeIndexes.length) return -1;
    for (let offset = 1; offset <= n; offset++) {
      const candidate = (from + offset) % n;
      if (activeIndexes.indexOf(candidate) >= 0) return candidate;
    }
    return -1;
  };
  const sbIdx = activeIndexes.length === 2 ? dealerIdx : nextActive(dealerIdx);
  const bbIdx = nextActive(sbIdx);

  let phtml = '';
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    let tag = '';
    if (i === dealerIdx) tag += '<span class="player-tag tag-d">D</span>';
    if (i === sbIdx) tag += '<span class="player-tag tag-sb">SB</span>';
    if (i === bbIdx) tag += '<span class="player-tag tag-bb">BB</span>';
    if (p.isAllIn) tag += '<span class="player-tag tag-allin">ALL</span>';
    if (!p.isConnected) tag += '<span class="player-tag tag-offline">离线</span>';

    const isTurn = i === state.currentPlayerIndex && !p.isFolded && !p.isAllIn && state.round !== 'showdown' && state.round !== 'waiting';
    let cls = 'player-item';
    if (p.id === myPlayerId) cls += ' is-you';
    if (isTurn) cls += ' is-turn';
    if (i === dealerIdx) cls += ' is-dealer';
    if (p.isFolded) cls += ' is-folded';
    if (p.isAllIn) cls += ' is-allin';

    phtml += '<div class="' + cls + '" data-initial="' + esc((p.name || '?').charAt(0)) + '">';
    phtml += '<div><span class="player-name">' + esc(p.name) + '</span>' + tag + '</div>';
    phtml += '<div style="text-align:right">';
    phtml += '<div class="player-chips">' + p.chips + '</div>';
    if (p.currentBet > 0) phtml += '<div class="player-bet">下注 ' + p.currentBet + '</div>';
    phtml += '</div></div>';
  }
  $('#game-players').innerHTML = phtml;

  $('#log-text').textContent = state.lastAction || '';
}

function renderLeaderboard(elementId, state, myPlayerId) {
  const ranked = state.players.slice().sort((a, b) => {
    if (b.chips !== a.chips) return b.chips - a.chips;
    return a.position - b.position;
  });
  let html = '';
  for (let i = 0; i < ranked.length; i++) {
    const p = ranked[i];
    html += '<div class="rank-row">';
    html += '<span class="rank-number">' + (i + 1) + '</span>';
    html += '<span class="rank-name">' + esc(p.name) + (p.id === myPlayerId ? ' <span class="text-xs text-dim">你</span>' : '') + '</span>';
    html += '<span class="rank-score">' + p.chips + '</span>';
    html += '</div>';
  }
  const el = document.getElementById(elementId);
  if (el) el.innerHTML = html || '<div class="log-text" style="padding:16px">等待玩家加入</div>';
}

// ---------- 操作栏渲染（供 actions.js / app.js 调用） ----------
export function renderActionBar(state, myPlayerId, handlers) {
  const me = state.players.find((p) => p.id === myPlayerId);
  const myIdx = state.players.findIndex((p) => p.id === myPlayerId);
  const actionBar = $('#action-bar');

  if (state.round === 'showdown') {
    actionBar.classList.add('visible');
    renderShowdown(state, myPlayerId, handlers);
    return;
  }

  if (isRoundComplete(state) && state.round !== 'showdown') {
    actionBar.classList.add('visible');
    $('#action-hint').textContent = '';
    $('#raise-control').style.display = 'none';
    $('#action-buttons').innerHTML = '<button class="btn btn-sm btn-primary" id="btn-next-round">下一轮</button>';
    const btn = $('#btn-next-round');
    if (btn) btn.onclick = handlers.onNextRound;
    return;
  }

  const isMyTurn = state.currentPlayerIndex === myIdx && me && !me.isFolded && !me.isAllIn && state.round !== 'showdown' && state.round !== 'waiting';
  if (!isMyTurn) {
    actionBar.classList.remove('visible');
    return;
  }

  actionBar.classList.add('visible');
  $('#raise-control').style.display = 'none';

  const toCall = state.currentBet - (me.currentBet || 0);
  $('#action-hint').textContent = toCall > 0 ? '需跟注 ' + toCall : '轮到你操作';

  let btns = '<button class="btn btn-sm btn-danger" id="btn-fold">弃牌</button>';
  if (toCall === 0) {
    btns += '<button class="btn btn-sm btn-primary" id="btn-check">过牌</button>';
  } else {
    btns += '<button class="btn btn-sm btn-primary" id="btn-call">跟注 ' + Math.min(toCall, me.chips) + '</button>';
  }
  btns += '<button class="btn btn-sm btn-secondary" id="btn-raise">加注</button>';
  $('#action-buttons').innerHTML = btns;

  $('#btn-fold').onclick = handlers.onFold;
  if (toCall === 0) {
    $('#btn-check').onclick = handlers.onCheck;
  } else {
    $('#btn-call').onclick = handlers.onCall;
  }
  $('#btn-raise').onclick = handlers.onShowRaise;
  $('#raise-amount').value = state.bigBlind;
}

function renderShowdown(state, myPlayerId, handlers) {
  $('#raise-control').style.display = 'none';
  const activePlayers = state.players.filter((p) => !p.isFolded && p.isActive);
  $('#action-hint').textContent = '选择获胜者';

  let btns = '';
  for (const p of activePlayers) {
    const sel = selectedWinners.has(p.id);
    btns += '<button class="btn btn-xs ' + (sel ? 'btn-primary' : 'btn-secondary') + '" data-winner="' + p.id + '">' + esc(p.name) + '</button>';
  }
  const disabled = selectedWinners.size === 0 ? ' style="opacity:.4"' : '';
  btns += '<button class="btn btn-xs btn-primary" id="btn-confirm-winners"' + disabled + '>确认</button>';
  $('#action-buttons').innerHTML = btns;

  $('#action-buttons').querySelectorAll('[data-winner]').forEach((b) => {
    b.onclick = () => handlers.onToggleWinner(b.dataset.winner);
  });
  const confirmBtn = $('#btn-confirm-winners');
  if (confirmBtn) confirmBtn.onclick = handlers.onConfirmWinners;
}

/** 本轮下注是否完成（前后端同源逻辑，供操作栏切换显示） */
export function isRoundComplete(state) {
  if (!state) return false;
  const actionable = state.players.filter((p) => !p.isFolded && p.isActive && !p.isAllIn);
  if (actionable.length === 0) return true;
  return actionable.every((p) => p.hasActedThisRound && p.currentBet === state.currentBet);
}
