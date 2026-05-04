/**
 * AIP-34: pino ベースのアプリケーションロガー。
 *
 * 仕様:
 *   - 出力: 開発時 (NODE_ENV !== 'production') は pino-pretty で stdout + ファイル、
 *           本番は pino-roll でファイルのみ。
 *   - ファイル: `<LOG_DIR>/<YYYY-MM-DD>.log`（pino-roll の dateFormat で日次切替）
 *   - レベル: `LOG_LEVEL` 環境変数（既定 'info'）
 *   - タグ: `getLogger(tag)` で `child({ tag })` を返し、既存の `[voice]` 等を維持
 *   - redact: トークン類のキーを念のためマスク
 *   - 古いログ削除: `cleanupOldLogs()` を index.ts から起動時 + 24h 間隔で呼ぶ
 */

import { existsSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join as joinPath, resolve as resolvePath } from 'node:path';
import pino, { type Logger, type TransportTargetOptions } from 'pino';

const DEFAULT_LOG_DIR = 'logs';
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_RETAIN_DAYS = 14;

function resolveLogDir(): string {
  const raw = process.env.LOG_DIR;
  const dir = raw && raw.trim().length > 0 ? raw.trim() : DEFAULT_LOG_DIR;
  return resolvePath(process.cwd(), dir);
}

function resolveLogLevel(): string {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (!raw) return DEFAULT_LOG_LEVEL;
  const allowed = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);
  return allowed.has(raw) ? raw : DEFAULT_LOG_LEVEL;
}

function resolveRetainDays(): number {
  const raw = process.env.LOG_RETAIN_DAYS;
  if (!raw) return DEFAULT_RETAIN_DAYS;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_RETAIN_DAYS;
}

const isDev = process.env.NODE_ENV !== 'production';

let rootLogger: Logger | null = null;

function buildTransport(): ReturnType<typeof pino.transport> {
  const logDir = resolveLogDir();
  const level = resolveLogLevel();

  const fileTarget: TransportTargetOptions = {
    target: 'pino-roll',
    level,
    options: {
      file: joinPath(logDir, 'app'),
      frequency: 'daily',
      dateFormat: 'yyyy-MM-dd',
      extension: '.log',
      mkdir: true,
    },
  };

  if (!isDev) {
    return pino.transport({ targets: [fileTarget] });
  }

  const prettyTarget: TransportTargetOptions = {
    target: 'pino-pretty',
    level,
    options: {
      destination: 1,
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname',
      messageFormat: '{if tag}[{tag}] {end}{msg}',
    },
  };

  return pino.transport({ targets: [prettyTarget, fileTarget] });
}

/** singleton ルートロガーを返す。初回呼び出しで初期化する。 */
export function createLogger(): Logger {
  if (rootLogger) return rootLogger;

  rootLogger = pino(
    {
      level: resolveLogLevel(),
      base: undefined, // pid/hostname を出さない（dev/prod とも）
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          '*.token',
          '*.apiKey',
          '*.api_key',
          '*.refreshToken',
          '*.refresh_token',
          '*.secret',
          '*.password',
          'token',
          'apiKey',
          'api_key',
          'refreshToken',
          'refresh_token',
          'secret',
          'password',
        ],
        censor: '[REDACTED]',
      },
    },
    buildTransport(),
  );

  return rootLogger;
}

/** 既存の `[xxx]` タグを child logger で表現したものを返す。 */
export function getLogger(tag: string): Logger {
  return createLogger().child({ tag });
}

export interface LogCleanupResult {
  deleted: string[];
  kept: string[];
}

/**
 * `<LOG_DIR>` 配下を走査し、`LOG_RETAIN_DAYS` 日より前の `.log` ファイルを削除する。
 * cleanup.ts の cleanupOldSessions と同じパターンで起動時 + 24h 周期で呼ばれる想定。
 */
export async function cleanupOldLogs(): Promise<LogCleanupResult> {
  const logDir = resolveLogDir();
  const retainDays = resolveRetainDays();
  const result: LogCleanupResult = { deleted: [], kept: [] };

  if (!existsSync(logDir)) return result;

  const cutoffMs = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  const log = getLogger('logs');

  let entries: string[];
  try {
    entries = await readdir(logDir);
  } catch (err) {
    log.error({ err }, `failed to read log dir ${logDir}`);
    return result;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.log')) continue;
    const path = joinPath(logDir, entry);
    try {
      const s = await stat(path);
      if (!s.isFile()) continue;
      if (s.mtimeMs < cutoffMs) {
        await unlink(path);
        result.deleted.push(entry);
      } else {
        result.kept.push(entry);
      }
    } catch (err) {
      log.warn({ err }, `failed to process log file ${path}`);
    }
  }

  return result;
}
