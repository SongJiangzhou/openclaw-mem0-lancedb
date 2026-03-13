import { appendFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DebugConfig } from '../types';

export interface PluginLoggerSink {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface PluginLogger {
  basic(event: string, fields?: Record<string, unknown>): void;
  verbose(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  exception(event: string, error: unknown, fields?: Record<string, unknown>): void;
  child(component: string, baseFields?: Record<string, unknown>): PluginLogger;
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
const LOCAL_DATE_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export class PluginDebugLogger {
  private readonly config: DebugConfig;
  private readonly sink?: PluginLoggerSink;
  private readonly component?: string;
  private readonly baseFields: Record<string, unknown>;

  constructor(
    config?: DebugConfig,
    sink?: PluginLoggerSink,
    options?: { component?: string; baseFields?: Record<string, unknown> },
  ) {
    this.config = config || { mode: 'off' };
    this.sink = sink;
    this.component = options?.component;
    this.baseFields = options?.baseFields || {};
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

  info(event: string, fields?: Record<string, unknown>): void {
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

  exception(event: string, error: unknown, fields?: Record<string, unknown>): void {
    const normalized = normalizeError(error);
    this.emit('error', event, {
      ...fields,
      message: normalized.message,
      ...(normalized.cause ? { cause: normalized.cause } : {}),
      ...(normalized.code ? { code: normalized.code } : {}),
    });
  }

  child(component: string, baseFields?: Record<string, unknown>): PluginLogger {
    const mergedComponent = this.component ? `${this.component}.${component}` : component;
    return new PluginDebugLogger(this.config, this.sink, {
      component: mergedComponent,
      baseFields: {
        ...this.baseFields,
        ...(baseFields || {}),
      },
    });
  }

  private emit(level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>): void {
    const payload = {
      ts: formatLocalTimestamp(new Date()),
      level,
      event,
      fields: sanitizeFields(this.withContext(fields || {})),
    };
    const line = JSON.stringify(payload);

    try {
      const logFn = this.sink?.[level] || console[level];
      logFn?.(line);
    } catch {
      // Never let debug logging break the caller.
    }

    if (this.config.mode === 'debug') {
      this.appendToDebugFile(line);
    }
  }

  private appendToDebugFile(line: string): void {
    try {
      const dir = path.join(os.homedir(), '.openclaw', 'workspace', 'logs', 'openclaw-mem0-lancedb');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${LOCAL_DATE_FORMATTER.format(new Date())}.log`);
      appendFileSync(file, `${line}\n`, 'utf8');
    } catch {
      // Never let debug logging break the caller.
    }
  }

  private withContext(fields: Record<string, unknown>): Record<string, unknown> {
    return {
      ...(this.component ? { component: this.component } : {}),
      ...this.baseFields,
      ...fields,
    };
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

function normalizeError(error: unknown): { message: string; cause?: string; code?: string } {
  if (error instanceof Error) {
    const maybeCode = (error as Error & { code?: unknown }).code;
    const normalized: { message: string; cause?: string; code?: string } = {
      message: error.message || String(error),
    };

    if (error.cause !== undefined) {
      normalized.cause = stringifyUnknown(error.cause);
    }

    if (typeof maybeCode === 'string' && maybeCode) {
      normalized.code = maybeCode;
    }

    return normalized;
  }

  return { message: stringifyUnknown(error) };
}

function stringifyUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message || String(value);
  }

  return String(value);
}
