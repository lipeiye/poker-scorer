// localStorage 相关：设备 ID、玩家身份持久化。纯函数，不碰 DOM。

const DEVICE_KEY = 'pk_device_id';
const PLAYERS_KEY = 'pk_players';
const LEGACY_KEY = 'pk_player';

export function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function getSavedPlayer(roomId) {
  try {
    const players = JSON.parse(localStorage.getItem(PLAYERS_KEY) || '{}');
    if (players[roomId]) return players[roomId];
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}');
    return legacy.roomId === roomId ? legacy : null;
  } catch {
    return null;
  }
}

export function savePlayer(roomId, playerId, name) {
  let players = {};
  try { players = JSON.parse(localStorage.getItem(PLAYERS_KEY) || '{}'); } catch { /* empty */ }
  players[roomId] = { roomId, playerId, name };
  localStorage.setItem(PLAYERS_KEY, JSON.stringify(players));
}
