// 玩家操作层：弃牌/过牌/跟注/加注/下一轮/摊牌选择/盲注设置。
// 集中处理：触觉反馈(M7)、弃牌二次确认(M8)、加注金额步进。
// 不直接持状态，所有操作通过 socket.send 发出。
import { $ } from './ui.js?v=3';
import { send } from './socket.js?v=3';
import { clearSelectedWinners, getSelectedWinners } from './render.js?v=3';

// ---------- M7: 触觉反馈 ----------
export function vibrate(pattern) {
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch { /* 部分浏览器拒绝 */ }
  }
}

// ---------- 加注控制 ----------
export function showRaise(state) {
  $('#raise-control').style.display = 'flex';
  $('#raise-amount').value = state.bigBlind;
  vibrate(8);
}

export function adjustRaise(dir, state, myPlayerId) {
  const inp = $('#raise-amount');
  const step = state.bigBlind;
  const me = state.players.find((p) => p.id === myPlayerId);
  const cur = parseInt(inp.value || step);
  // 下限 = 大盲（与后端最小加注一致，见 A2），上限 = 我的全部筹码
  const max = me ? me.chips : step;
  inp.value = Math.max(step, Math.min(cur + dir * step, max));
}

export function doRaise() {
  const amount = parseInt($('#raise-amount').value) || 0;
  sendAction('raise', amount);
}

// ---------- M8: 弃牌二次确认（防误触） ----------
let foldArmed = false;
let foldArmTimer = null;

export function onFoldClick() {
  const btn = $('#btn-fold');
  if (!btn) return;
  if (!foldArmed) {
    // 第一次点：武装确认态，2 秒后自动撤销
    foldArmed = true;
    btn.textContent = '再点一次确认';
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-primary');
    vibrate(20);
    clearTimeout(foldArmTimer);
    foldArmTimer = setTimeout(resetFold, 2000);
    return;
  }
  resetFold();
  sendAction('fold');
}

function resetFold() {
  foldArmed = false;
  clearTimeout(foldArmTimer);
  const btn = $('#btn-fold');
  if (btn) {
    btn.textContent = '弃牌';
    btn.classList.add('btn-danger');
    btn.classList.remove('btn-primary');
  }
}

// ---------- 通用发送 ----------
export function sendAction(action, amount) {
  const msg = { type: 'action', action };
  if (amount != null) msg.amount = amount;
  send(msg);
  $('#action-bar').classList.remove('visible');
  vibrate(action === 'fold' ? 30 : 12);
}

export function startHand() {
  send({ type: 'startHand' });
}

export function nextRound() {
  send({ type: 'nextRound' });
}

// ---------- 摊牌选择 ----------
export function confirmWinners() {
  const ids = getSelectedWinners();
  if (ids.length === 0) return;
  send({ type: 'endHand', winnerIds: ids });
  clearSelectedWinners();
}

// ---------- 盲注设置 ----------
export function updateSettings() {
  const sb = parseInt($('#set-sb').value) || 10;
  const bb = parseInt($('#set-bb').value) || 20;
  if (bb <= sb) return; // 后端会校验，前端先挡一层
  send({ type: 'updateSettings', settings: { smallBlind: sb, bigBlind: bb } });
}
