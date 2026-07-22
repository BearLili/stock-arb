/** 结构化日志（pino）。控制台开发用 pretty，生产为 JSON。 */
import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY;

export const log = pino(
  pretty
    ? {
        level,
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : { level },
);

export function childLog(name: string): pino.Logger {
  return log.child({ feed: name });
}
