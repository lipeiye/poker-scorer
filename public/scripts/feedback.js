// M9: "轮到你"的强提示。手机锁屏/切后台时玩家也能感知。
// 三种信号：屏幕内醒目横幅（视觉）、document.title 改动（tab/后台可见）、振动。
// 音效已移除（Web Audio API 会导致 macOS/iOS 抢占 AirPods）。
const TITLE_ON = '● 轮到你 — 德扑计分';
const TITLE_IDLE = 'PK · 德扑计分';

let wasMyTurn = false;
let bannerTimer = 0;

function showBanner() {
  const banner = document.getElementById('turn-banner');
  if (!banner) return;
  banner.classList.add('show');
  clearTimeout(bannerTimer);
  // 横幅展示 ~2.5s 后淡出；玩家卡片的高亮会持续到出牌。
  bannerTimer = setTimeout(() => banner.classList.remove('show'), 2500);
}

function hideBanner() {
  const banner = document.getElementById('turn-banner');
  if (banner) banner.classList.remove('show');
  clearTimeout(bannerTimer);
}

/**
 * 检查"是否轮到我"的状态变化，触发提示。
 * @param {boolean} myTurn   当前是否轮到我
 * @param {boolean} visible  页面是否可见（document.visibilityState === 'visible'）
 */
export function notifyMyTurn(myTurn, visible) {
  // 只在"从不轮我 → 轮我"的上升沿触发，避免每次渲染都响
  if (myTurn && !wasMyTurn) {
    document.title = TITLE_ON;
    if (visible) showBanner();
    if (navigator.vibrate) {
      try { navigator.vibrate([40, 60, 40]); } catch { /* ignore */ }
    }
  } else if (!myTurn) {
    document.title = TITLE_IDLE;
    hideBanner();
  }
  wasMyTurn = myTurn;
}
