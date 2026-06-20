import { generateRoomCode, ROOM_TTL_MS } from './types';
import type { Env } from './env';

export { GameRoom } from './game-room';
export { RoomRegistry } from './room-registry';

async function roomExists(env: Env, roomId: string): Promise<boolean> {
  const registry = env.ROOM_REGISTRY.getByName(roomId);
  if (await registry.exists()) return true;

  // 兼容升级前已经存在的房间：只读取存储，不会创建新牌局。
  const room = env.GAME_ROOM.getByName(roomId);
  const response = await room.fetch(`https://internal/api/rooms/${roomId}/exists`);
  if (!response.ok) return false;

  const metadata = await response.json<{ exists: boolean; createdAt?: number }>();
  if (!metadata.exists || !metadata.createdAt) return false;

  const expiresAt = metadata.createdAt + ROOM_TTL_MS;
  if (expiresAt <= Date.now()) return false;
  await registry.claim(expiresAt);
  return true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/rooms' && request.method === 'POST') {
      let body: any = {};
      try { body = await request.json(); } catch { /* use defaults */ }

      let roomId = '';
      const expiresAt = Date.now() + ROOM_TTL_MS;
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = generateRoomCode();
        if (await env.ROOM_REGISTRY.getByName(candidate).claim(expiresAt)) {
          roomId = candidate;
          break;
        }
      }
      if (!roomId) {
        return Response.json({ message: '暂时无法创建房间，请稍后重试' }, { status: 503 });
      }

      const stub = env.GAME_ROOM.getByName(roomId);

      const initReq = new Request(
        `https://internal/api/rooms/${roomId}/init`,
        {
          method: 'POST',
          body: JSON.stringify({ ...body, expiresAt }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const initRes = await stub.fetch(initReq);
      if (!initRes.ok) {
        await env.ROOM_REGISTRY.getByName(roomId).remove();
        return Response.json({ message: '房间初始化失败' }, { status: 500 });
      }
      const initData: any = await initRes.json();

      return Response.json({
        roomId,
        smallBlind: initData.smallBlind,
        bigBlind: initData.bigBlind,
      });
    }

    const roomMatch = path.match(/^\/api\/rooms\/([A-Z2-9]{6})/);
    if (roomMatch) {
      const roomId = roomMatch[1];
      if (!await roomExists(env, roomId)) {
        return Response.json({ message: '房间码不存在或已过期' }, { status: 404 });
      }
      if (path === `/api/rooms/${roomId}/exists` && request.method === 'GET') {
        return Response.json({ exists: true, roomId });
      }
      const stub = env.GAME_ROOM.getByName(roomId);
      return stub.fetch(request);
    }
    if (path.startsWith('/api/rooms/')) {
      return Response.json({ message: '房间码不存在或已过期' }, { status: 404 });
    }

    const wsMatch = path.match(/^\/ws\/([A-Z2-9]{6})/);
    if (wsMatch) {
      const roomId = wsMatch[1];
      if (!await roomExists(env, roomId)) {
        return Response.json({ message: '房间码不存在或已过期' }, { status: 404 });
      }
      const stub = env.GAME_ROOM.getByName(roomId);
      return stub.fetch(request);
    }
    if (path.startsWith('/ws/')) {
      return Response.json({ message: '房间码不存在或已过期' }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
};
