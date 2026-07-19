// 玩家操作层：弃牌/过牌/跟注/加注/全押/下一轮/摊牌排名分档/盲注设置。
// 集中处理：触觉反馈(M7)、弃牌二次确认(M8)、加注金额步进、加注总额实时预览。
// 不直接持状态，所有操作通过 socket.send 发出。
import { $, toast } from './ui.js?v=12';
import { send, getMyPlayerId } from './socket.js?v=12';
import {
  clearSelectedWinners,
  clearSettlementPreview,
  getTiers,
  setSettlementPreview,
  advanceTier,
  undoTier,
} from './render.js?v=12';

// ---------- M7: 触觉反馈 ----------
export function vibrate(pattern) {
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch { /* 部分浏览器拒绝 */ }
  }
}

// ---------- 加注控制 ----------
export function showRaise(state, myPlayerId) {
  $('#raise-control').style.display = 'flex';
  const me = state.players.find((p) => p.id === myPlayerId);
  const max = me ? me.chips : state.bigBlind;
  const inp = $('#raise-amount');
  inp.value = state.bigBlind;
  inp.max = max;
  updateRaiseHint(state, myPlayerId);
  vibrate(8);
}

/** 加注总额实时预览：把"增量"语义翻译成玩家能看懂的"加注到 X / 总投入 Y"。 */
function updateRaiseHint(state, myPlayerId) {
  const inp = $('#raise-amount');
  const me = state.players.find((p) => p.id === myPlayerId);
  if (!inp || !me) return;
  const raiseAmount = Math.max(0, parseInt(inp.value) || 0);
  const toCall = Math.max(0, state.currentBet - (me.currentBet || 0));
  const totalNeeded = toCall + raiseAmount;          // 本次要掏出的筹码
  const newCurrentBet = state.currentBet + raiseAmount; // 加注后全桌需跟到的线
  const hint = $('#action-hint');
  if (hint) {
    hint.textContent = raiseAmount > 0
      ? `加注 +${raiseAmount}｜本次投入 ${totalNeeded}｜线到 ${newCurrentBet}`
      : (toCall > 0 ? `需跟注 ${toCall}` : '轮到你操作');
  }
}

export function adjustRaise(dir, state, myPlayerId) {
  const inp = $('#raise-amount');
  const step = state.bigBlind;
  const me = state.players.find((p) => p.id === myPlayerId);
  const cur = parseInt(inp.value || step);
  const min = parseInt(inp.min) || step;
  // 下限 = 大盲，上限 = 我的全部筹码
  const max = me ? me.chips : step;
  inp.value = Math.max(min, Math.min(cur + dir * step, max));
  updateRaiseHint(state, myPlayerId);
}

/** 输入框直接改动时（input 事件）刷新总额预览 */
export function onRaiseInput(state, myPlayerId) {
  updateRaiseHint(state, myPlayerId);
}

export function doRaise() {
  const inp = $('#raise-amount');
  const amount = parseInt(inp.value) || 0;
  const min = parseInt(inp.min) || 0;
  if (min > 0 && amount < min) {
    toast(`最低加注 ${min} 筹码`);
    return;
  }
  sendAction('raise', amount);
}

// ---------- 全押 ----------
export function doAllIn(state, myPlayerId) {
  const me = state.players.find((p) => p.id === myPlayerId);
  if (!me || me.chips <= 0) return;
  // 服务端 raise 分支：totalNeeded >= chips 自动走 all-in，无需新协议。
  sendAction('raise', me.chips);
}

// ---------- M8: 弃牌二次确认（防误触） ----------
// 注意：弃牌按钮由 renderActionBar 用 data-action="fold" 渲染（无固定 id），
// 因此由 app.js 的事件委托把被点击的按钮元素传入，不能按 id 查找。
let foldArmed = null;          // 当前处于武装确认态的按钮元素
let foldArmTimer = null;

export function onFoldClick(btn) {
  if (!btn) return;
  if (foldArmed !== btn) {
    // 第一次点该按钮：武装确认态，2 秒后自动撤销
    resetFold();
    foldArmed = btn;
    btn.dataset.originalText = btn.textContent;
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
  if (foldArmed && foldArmed.isConnected) {
    if (foldArmed.dataset.originalText != null) foldArmed.textContent = foldArmed.dataset.originalText;
    foldArmed.classList.add('btn-danger');
    foldArmed.classList.remove('btn-primary');
    delete foldArmed.dataset.originalText;
  }
  foldArmed = null;
  clearTimeout(foldArmTimer);
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

// ---------- 摊牌排名分档 ----------
let pendingSettlementTiers = null;
let settlementSubmitting = false;

/** 把当前档位提交并入下一档 */
export function nextTier() {
  advanceTier();
}

export function prevTier() {
  undoTier();
}

/** 先请求服务端权威预览；未看过预览不能发送真实结算。 */
export function confirmTiers() {
  const tiers = getTiers();
  if (tiers.length === 0) return;
  pendingSettlementTiers = tiers.map((tier) => tier.slice());
  clearSettlementPreview();
  send({ type: 'previewEndHand', tiers: pendingSettlementTiers });
}

export function applySettlementPreview(preview) {
  if (!pendingSettlementTiers || !preview) return false;
  settlementSubmitting = false;
  setSettlementPreview(preview);
  return true;
}

export function commitSettlement() {
  if (!pendingSettlementTiers || settlementSubmitting) return;
  settlementSubmitting = true;
  send({ type: 'endHand', tiers: pendingSettlementTiers });
}

export function handleSettlementError() {
  settlementSubmitting = false;
}

export function cancelSettlementPreview() {
  settlementSubmitting = false;
  pendingSettlementTiers = null;
  clearSettlementPreview();
}

export function resetSettlementFlow() {
  settlementSubmitting = false;
  pendingSettlementTiers = null;
  clearSelectedWinners();
}

// ---------- 盲注设置 ----------
export function updateSettings() {
  const sb = parseInt($('#set-sb').value) || 10;
  const bb = parseInt($('#set-bb').value) || 20;
  if (bb <= sb) return; // 后端会校验，前端先挡一层
  if (!confirm(`将盲注改为 SB ${sb}/BB ${bb}？`)) return;
  send({ type: 'updateSettings', settings: { smallBlind: sb, bigBlind: bb } });
}

// ---------- 补码 / 移除离线玩家（仅 waiting） ----------
/** 默认补 1000（与后端 DEFAULT_CHIPS 一致）；可传入 amount */
export function rebuy(targetPlayerId, amount) {
  if (targetPlayerId && targetPlayerId !== getMyPlayerId()
    && !confirm('确定给该玩家补码？')) return;
  const msg = { type: 'rebuy', targetPlayerId };
  if (amount != null) msg.amount = amount;
  send(msg);
  vibrate(10);
}

export function removePlayer(targetPlayerId) {
  if (!targetPlayerId) return;
  send({ type: 'removePlayer', targetPlayerId });
  vibrate(15);
}
