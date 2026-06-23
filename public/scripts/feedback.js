// M9: "轮到你"的强提示。手机锁屏/切后台时玩家也能感知。
// 三种信号：document.title 改动（tab/后台可见）、振动、可选轻提示音（需用户已交互过）。
const TITLE_ON = '● 轮到你 — 德扑计分';
const TITLE_IDLE = 'PK · 德扑计分';

let wasMyTurn = false;
let audioCtx = null;

/** 进入页面后用户首次交互时解锁 AudioContext（浏览器自动播放策略） */
export function unlockAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch { /* 无音频能力则跳过，不影响游戏 */ }
}

/** 短促提示音，仅用原生 Web Audio，不引入音频文件/库 */
function beep() {
  if (!audioCtx || audioCtx.state === 'closed') return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.value = 880;
  osc.type = 'sine';
  gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.2);
}

/**
 * 检查"是否轮到我"的状态变化，触发提示。
 * @param {boolean} isMyTurn 当前是否轮到我
 * @param {boolean} visible   页面是否可见（document.visibilityState === 'visible'）
 */
export function notifyMyTurn(isMyTurn, visible) {
  // 只在"从不轮我 → 轮我"的上升沿触发，避免每次渲染都响
  if (isMyTurn && !wasMyTurn) {
    document.title = TITLE_ON;
    if (navigator.vibrate) {
      try { navigator.vibrate([40, 60, 40]); } catch { /* ignore */ }
    }
    // 后台或刚切回时给一声提示；前台也有振动即可，避免过度打扰
    if (!visible) beep();
  } else if (!isMyTurn) {
    document.title = TITLE_IDLE;
  }
  wasMyTurn = isMyTurn;
}
