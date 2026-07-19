// 渲染层：根据后端 state 渲染大厅 / 游戏界面 / 摊牌 / 庆祝。
// 只读 state、只写 DOM，不直接发消息（操作由 app.js 通过事件委托处理）。
import { $, esc, showView } from './ui.js?v=9';

/** 把断线时间戳格式化成「已离线 N秒/N分钟/N小时」。无时间戳返回 '离线'。 */
function formatOfflineDuration(disconnectedAt) {
  if (!disconnectedAt) return '离线';
  const sec = Math.max(0, Math.floor((Date.now() - disconnectedAt) / 1000));
  if (sec < 60) return `已离线 ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `已离线 ${min}min`;
  const hr = Math.floor(min / 60);
  return `已离线 ${hr}h`;
}

/** 统一的"是否轮到我"判定（4 字段谓词），供 renderGame / renderActionBar / app.js 复用。
 *  与后端 game-room.ts advanceTurn 的跳过条件同源。 */
export function isMyTurn(state, myPlayerId) {
  if (!state) return false;
  const myIdx = state.players.findIndex((p) => p.id === myPlayerId);
  const me = myIdx >= 0 ? state.players[myIdx] : null;
  return state.currentPlayerIndex === myIdx
    && !!me && !me.isFolded && me.isActive && !me.isAllIn && !me.isSittingOut
    && state.round !== 'showdown' && state.round !== 'waiting';
}

// ---------- 摊牌排名分档状态 ----------
// selectedTiers: 已确认的名次档位数组（tiers[0]=第1名/可并列，tiers[1]=第2名…）
// currentTier:   正在选择的当前档位（Set），还没"下一档"提交。
let selectedTiers = [];
let currentTier = new Set();

export function clearSelectedWinners() {
  selectedTiers = [];
  currentTier.clear();
}

/** 切换当前档位中某玩家的选中态 */
export function toggleWinner(id) {
  if (currentTier.has(id)) currentTier.delete(id);
  else currentTier.add(id);
}

/** 当前档位提交，进入下一档 */
export function advanceTier() {
  if (currentTier.size === 0) return false;
  selectedTiers.push(Array.from(currentTier));
  currentTier.clear();
  return true;
}

/** 撤销最近一档（回退到上一档继续编辑） */
export function undoTier() {
  const last = selectedTiers.pop();
  if (last) currentTier = new Set(last);
}

/** 取已确认 + 当前档位拼成的完整 tiers（用于发送） */
export function getTiers() {
  const tiers = selectedTiers.slice();
  if (currentTier.size > 0) tiers.push(Array.from(currentTier));
  return tiers;
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

/** 构建玩家索引映射，避免反复 O(n) 查找 */
function buildPlayerMap(players, myPlayerId) {
  const indexById = new Map();
  players.forEach((p, i) => indexById.set(p.id, i));
  const myIdx = indexById.has(myPlayerId) ? indexById.get(myPlayerId) : -1;
  const me = myIdx >= 0 ? players[myIdx] : null;
  return { indexById, myIdx, me };
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

  const { me } = buildPlayerMap(state.players, myPlayerId);
  $('#btn-start').style.display = me ? '' : 'none';

  $('#lobby-players').innerHTML = state.players.map((p) => {
    const rebuyBtn = `<button class="btn btn-xs btn-secondary" data-action="rebuy" data-player="${p.id}" title="补码 +1000">+码</button>`;
    const removeBtn = !p.isConnected
      ? `<button class="btn btn-xs btn-danger" data-action="remove-player" data-player="${p.id}" title="移除离线玩家">移除</button>`
      : '';
    return `
    <div class="player-item${p.id === myPlayerId ? ' is-you' : ''}" data-initial="${esc((p.name || '?').charAt(0))}">
      <span class="player-name">${esc(p.name)}${p.id === myPlayerId ? ' <span class="text-xs text-dim">(你)</span>' : ''}${!p.isConnected ? ` <span class="player-tag tag-offline">${formatOfflineDuration(p.disconnectedAt)}</span>` : ''}</span>
      <span class="player-chips-row">
        <span class="player-chips">${p.chips}</span>
        ${rebuyBtn}${removeBtn}
      </span>
    </div>`;
  }).join('');
}

// ---------- 游戏 ----------
const ROUND_NAMES = { waiting: '等待', preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌' };

function renderGame(state, myPlayerId) {
  $('#game-code').textContent = state.roomId;
  $('#game-hand').textContent = state.handNumber > 0 ? `第${state.handNumber}手` : '';
  $('#round-bar').innerHTML = `<span class="round-name">${ROUND_NAMES[state.round] || state.round}</span>`;

  $('#community-cards').innerHTML = Array.from({ length: 5 }, (_, i) => `
    <div class="card-slot${i < state.communityCards ? ' dealt' : ''}">${i < state.communityCards ? '🂠' : ''}</div>
  `).join('');

  animatePot(state.pot);
  renderLeaderboard('game-leaderboard', state, myPlayerId);

  const n = state.players.length;
  const dealerIdx = state.dealerIndex;
  const activeIndexes = new Set(state.players.map((p, i) => (p.isActive ? i : -1)).filter((i) => i >= 0));
  const nextActive = (from) => {
    if (activeIndexes.size === 0) return -1;
    for (let offset = 1; offset <= n; offset++) {
      const candidate = (from + offset) % n;
      if (activeIndexes.has(candidate)) return candidate;
    }
    return -1;
  };
  const sbIdx = activeIndexes.size === 2 ? dealerIdx : nextActive(dealerIdx);
  const bbIdx = nextActive(sbIdx);

  $('#game-players').innerHTML = state.players.map((p, i) => {
    const tag = [
      i === dealerIdx ? '<span class="player-tag tag-d">D</span>' : '',
      i === sbIdx ? '<span class="player-tag tag-sb">SB</span>' : '',
      i === bbIdx ? '<span class="player-tag tag-bb">BB</span>' : '',
      p.isAllIn ? '<span class="player-tag tag-allin">ALL</span>' : '',
      p.isSittingOut ? `<span class="player-tag tag-offline">暂离·${formatOfflineDuration(p.disconnectedAt)}</span>` : (!p.isConnected ? `<span class="player-tag tag-offline">${formatOfflineDuration(p.disconnectedAt)}</span>` : ''),
    ].join('');

    const isTurn = i === state.currentPlayerIndex && !p.isFolded && p.isActive && !p.isAllIn && !p.isSittingOut && state.round !== 'showdown' && state.round !== 'waiting';
    const cls = [
      'player-item',
      p.id === myPlayerId ? 'is-you' : '',
      isTurn ? 'is-turn' : '',
      i === dealerIdx ? 'is-dealer' : '',
      p.isFolded ? 'is-folded' : '',
      p.isAllIn ? 'is-allin' : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="${cls}" data-initial="${esc((p.name || '?').charAt(0))}">
        <div><span class="player-name">${esc(p.name)}</span>${tag}</div>
        <div style="text-align:right">
          <div class="player-chips">${p.chips}</div>
          ${p.currentBet > 0 ? `<div class="player-bet">下注 ${p.currentBet}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  $('#log-text').textContent = state.lastAction || '';
}

function renderLeaderboard(elementId, state, myPlayerId) {
  const ranked = state.players.slice().sort((a, b) => {
    if (b.chips !== a.chips) return b.chips - a.chips;
    return a.position - b.position;
  });
  const html = ranked.map((p, i) => `
    <div class="rank-row">
      <span class="rank-number">${i + 1}</span>
      <span class="rank-name">${esc(p.name)}${p.id === myPlayerId ? ' <span class="text-xs text-dim">你</span>' : ''}</span>
      <span class="rank-score">${p.chips}</span>
    </div>
  `).join('');
  const el = document.getElementById(elementId);
  if (el) el.innerHTML = html || '<div class="log-text" style="padding:16px">等待玩家加入</div>';
}

// ---------- 操作栏渲染 ----------
export function renderActionBar(state, myPlayerId) {
  const { me } = buildPlayerMap(state.players, myPlayerId);
  const actionBar = $('#action-bar');

  if (state.round === 'showdown') {
    actionBar.classList.add('visible');
    renderShowdown(state, myPlayerId);
    return;
  }

  if (isRoundComplete(state)) {
    actionBar.classList.add('visible');
    $('#action-hint').textContent = '';
    $('#raise-control').style.display = 'none';
    $('#action-buttons').innerHTML = '<button class="btn btn-sm btn-primary" data-action="next-round">下一轮</button>';
    return;
  }

  if (!isMyTurn(state, myPlayerId)) {
    actionBar.classList.remove('visible');
    return;
  }

  actionBar.classList.add('visible');
  $('#raise-control').style.display = 'none';

  const toCall = state.currentBet - (me.currentBet || 0);
  $('#action-hint').textContent = toCall > 0 ? `需跟注 ${toCall}` : '轮到你操作';

  const callBtn = toCall === 0
    ? '<button class="btn btn-sm btn-primary" data-action="check">过牌</button>'
    : `<button class="btn btn-sm btn-primary" data-action="call">跟注 ${Math.min(toCall, me.chips)}</button>`;

  // All-in 按钮：醒目，直接全押全部筹码（无需打开加注控件慢慢调）。
  const allInBtn = me.chips > 0
    ? `<button class="btn btn-sm btn-allin" data-action="all-in">全押 ${me.chips}</button>`
    : '';

  $('#action-buttons').innerHTML = `
    <button class="btn btn-sm btn-danger" data-action="fold">弃牌</button>
    ${callBtn}
    <button class="btn btn-sm btn-secondary" data-action="raise">加注</button>
    ${allInBtn}
  `;

  $('#raise-amount').value = state.bigBlind;
  $('#raise-amount').min = state.bigBlind;
  $('#raise-amount').max = me.chips;
}



function renderShowdown(state, myPlayerId) {
  $('#raise-control').style.display = 'none';
  // 候选：所有未弃牌者（含挂机）。断线挂机仍占座争夺底池，物理牌桌上牌仍在，必须能选胜。
  const activePlayers = state.players.filter((p) => !p.isFolded);
  const tierIndex = selectedTiers.length; // 0 = 第1名
  const tierLabel = tierIndex === 0 ? '第 1 名（可并列选平手）' : `第 ${tierIndex + 1} 名`;

  $('#action-hint').textContent = `摊牌 · 选择${tierLabel}（有边池时请用「下一档」排完）`;

  const confirmDisabled = currentTier.size === 0 && selectedTiers.length === 0 ? ' style="opacity:.4;pointer-events:none"' : '';
  const nextDisabled = currentTier.size === 0 ? ' style="opacity:.4;pointer-events:none"' : '';
  const undoBtn = selectedTiers.length > 0
    ? '<button class="btn btn-xs btn-secondary" data-action="undo-tier">上一档</button>'
    : '';

  $('#action-buttons').innerHTML = activePlayers.map((p) => {
    const sel = currentTier.has(p.id);
    const tag = p.isSittingOut ? '·暂离' : '';
    return `<button class="btn btn-xs ${sel ? 'btn-primary' : 'btn-secondary'}" data-winner="${p.id}">${esc(p.name)}${tag}</button>`;
  }).join('')
    + `<button class="btn btn-xs btn-secondary" data-action="next-tier"${nextDisabled}>下一档</button>`
    + undoBtn
    + `<button class="btn btn-xs btn-primary" data-action="confirm-tiers"${confirmDisabled}>确认结算</button>`;
}

/** 本轮下注是否完成（前后端同源逻辑） */
export function isRoundComplete(state) {
  if (!state) return false;
  const actionable = state.players.filter((p) => !p.isFolded && p.isActive && !p.isAllIn && !p.isSittingOut);
  if (actionable.length === 0) return true;
  return actionable.every((p) => p.hasActedThisRound && p.currentBet === state.currentBet);
}
