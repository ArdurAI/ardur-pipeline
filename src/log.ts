/**
 * Structured logging. Every line is a single JSON object (default) so a cycle
 * run is greppable in CI logs and shippable to any log backend; `pretty` mode
 * is for local eyes. All entries carry the `cycleId` so concurrent or
 * backfilled cycles never tangle.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  child(fields: LogFields): Logger;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  format: 'json' | 'pretty';
  minLevel?: LogLevel;
  /** Injectable clock so cycles stay reproducible in tests. */
  now?: () => Date;
  /** Injectable sink (defaults to stderr so stdout stays clean for artifacts). */
  write?: (line: string) => void;
}

export function createLogger(options: LoggerOptions, base: LogFields = {}): Logger {
  const minLevel = LEVELS[options.minLevel ?? 'debug'];
  const now = options.now ?? (() => new Date());
  const write = options.write ?? ((line: string) => process.stderr.write(line + '\n'));

  function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (LEVELS[level] < minLevel) return;
    const merged = { ...base, ...fields };
    if (options.format === 'pretty') {
      const extra = Object.keys(merged).length ? ' ' + JSON.stringify(merged) : '';
      write(`[${now().toISOString()}] ${level.toUpperCase().padEnd(5)} ${message}${extra}`);
      return;
    }
    write(JSON.stringify({ ts: now().toISOString(), level, message, ...merged }));
  }

  return {
    child: (fields) => createLogger(options, { ...base, ...fields }),
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}
