import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

interface RoomRecord {
  expiresAt: number;
}

export class RoomRegistry extends DurableObject<Env> {
  async claim(expiresAt: number): Promise<boolean> {
    const current = await this.ctx.storage.get<RoomRecord>('room');
    if (current) return false;

    await this.ctx.storage.put('room', { expiresAt } satisfies RoomRecord);
    return true;
  }

  async exists(): Promise<boolean> {
    const room = await this.ctx.storage.get<RoomRecord>('room');
    return Boolean(room && room.expiresAt > Date.now());
  }

  async remove(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
