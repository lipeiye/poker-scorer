// 视图层小工具：DOM 查询、toast、modal 开关、连接状态点、深链预填、iOS 键盘适配。
// 刻意保持薄：只做"显示什么"，不做"游戏怎么走"。

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => document.querySelectorAll(sel);

let toastTimer = null;
export function toast(msg, dur = 1500) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), dur);
}

export function showView(id) {
  $$('.view').forEach((v) => v.classList.remove('active'));
  $(`#view-${id}`).classList.add('active');
}

export function showModal(id) {
  $(`#${id}`).classList.add('visible');
}
export function closeModal(id) {
  $(`#${id}`).classList.remove('visible');
}

/** 关掉最上层 modal。返回是否关了一个。 */
export function closeTopModal() {
  for (const id of ['winner-modal', 'name-modal', 'share-modal']) {
    if ($(`#${id}`).classList.contains('visible')) {
      closeModal(id);
      return true;
    }
  }
  return false;
}

/** 文本转义，避免玩家名字里的 HTML 字符破坏渲染。 */
export function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

/** 把连接状态映射成顶栏小圆点的 class + 文案（lobby/game 两处都更新） */
export function renderConnDot(state) {
  let cls = '';
  let label = '';
  if (state === 'connecting') { cls = 'connecting'; label = '重连中'; }
  else if (state === 'offline') { cls = 'offline'; label = '已断开'; }
  document.querySelectorAll('.conn-dot').forEach((dot) => {
    dot.classList.remove('connecting', 'offline');
    if (cls) dot.classList.add(cls);
  });
  document.querySelectorAll('.conn-text').forEach((t) => { t.textContent = label; });
}

/** M6: 读取 ?room= 深链参数，预填进加入输入框 */
export function applyDeepLink() {
  try {
    const params = new URLSearchParams(location.search);
    const room = (params.get('room') || '').toUpperCase();
    if (/^[A-HJ-NP-Z2-9]{6}$/.test(room)) {
      const input = $('#join-code');
      if (input) input.value = room;
      return room;
    }
  } catch { /* ignore */ }
  return null;
}

/** M13/M15: iOS/Android 键盘适配。
 *  - 输入框聚焦时给 body 加 keyboard-open，调整首页/弹窗布局并滚动到可视区
 *  - 键盘升起时给操作栏加 keyboard 类，fixed 切 absolute 贴可视区底部
 */
export function installKeyboardAdapter() {
  const bar = $('#action-bar');
  if (window.visualViewport && bar) {
    const vv = window.visualViewport;
    const layoutH = window.innerHeight;
    const update = () => bar.classList.toggle('keyboard', layoutH - vv.height > 100);
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
  }

  // 事件委托：兼容未来动态添加的输入框
  let focusTimer = null;
  document.body.addEventListener('focusin', (e) => {
    if (e.target.tagName !== 'INPUT') return;
    if (focusTimer) clearTimeout(focusTimer);
    document.body.classList.add('keyboard-open');
    focusTimer = setTimeout(() => {
      e.target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 280);
  });
  document.body.addEventListener('focusout', () => {
    if (focusTimer) clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      if (document.activeElement?.tagName !== 'INPUT') {
        document.body.classList.remove('keyboard-open');
      }
    }, 100);
  });
}
