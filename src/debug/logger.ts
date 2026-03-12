import type { DebugConfig } from '../types';

export interface PluginLoggerSink {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

const TEXT_PREVIEW_LIMIT = 200;
const REDACTED = '[redacted]';
const LOCAL_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hour12: false,
});
export class PluginDebugLogger {
  private readonly config: DebugConfig;
  private readonly sink?: PluginLoggerSink;

  constructor(config?: DebugConfig, sink?: PluginLoggerSink) {
    this.config = config || { mode: 'off' };
    this.sink = sink;
  }

  basic(event: string, fields?: Record<string, unknown>): void {
    if (this.config.mode === 'off') {
      return;
    }

    this.emit('info', event, fields);
  }

  verbose(event: string, fields?: Record<string, unknown>): void {
    if (this.config.mode === 'off') {
      return;
    }

    this.emit('info', event, fields);
  }

  warn(event: string, fields?: Record<string, unknown>): void {
    this.emit('warn', event, fields);
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.emit('error', event, fields);
  }

  private emit(level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>): void {
    const payload = {
      ts: formatLocalTimestamp(new Date()),
      level,
      event,
      fields: sanitizeFields(fields || {}),
    };
    const line = JSON.stringify(payload);

    try {
      const logFn = this.sink?.[level] || console[level];
      logFn?.(line);
    } catch {
      // Never let debug logging break the caller.
    }
  }
}

export function summarizeText(value: unknown, maxChars: number = TEXT_PREVIEW_LIMIT): Record<string, unknown> {
  const text = String(value || '');
  return {
    text_preview: text.length > maxChars ? `${text.slice(0, maxChars)}...` : text,
    text_length: text.length,
  };
}

function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (/api.?key/i.test(key)) {
      sanitized[key] = REDACTED;
      continue;
    }

    if (typeof value === 'string' && value.length > TEXT_PREVIEW_LIMIT) {
      sanitized.text_preview = `${value.slice(0, TEXT_PREVIEW_LIMIT)}...`;
      sanitized[`${key}_length`] = value.length;
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

function formatLocalTimestamp(value: Date): string {
  const dateTime = LOCAL_DATE_TIME_FORMATTER.format(value).replace(' ', 'T');
  const offsetMinutes = -value.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absOffsetMinutes / 60)).padStart(2, '0');
  const offsetMins = String(absOffsetMinutes % 60).padStart(2, '0');

  return `${dateTime}${sign}${offsetHours}:${offsetMins}`;
}
