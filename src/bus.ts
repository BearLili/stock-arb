/**
 * 进程内事件总线：feeds → [recorder, engine]。
 * M0/M1 单进程；将来拆 collector/engine/executor 三进程时，此处换成 IPC 即可，
 * 上下游只依赖事件接口不变。
 */
import { EventEmitter } from 'node:events';
import type { BboEvent } from './types.js';

export interface BusEvents {
  bbo: (e: BboEvent) => void;
}

export class Bus extends EventEmitter {
  emitBbo(e: BboEvent): void {
    this.emit('bbo', e);
  }

  onBbo(fn: (e: BboEvent) => void): void {
    this.on('bbo', fn);
  }
}
