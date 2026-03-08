import type { PluginConfig } from '../types';

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '0.0.0.0'];

/**
 * Returns true when the configured Mem0 base URL points to a local endpoint
 * (localhost / 127.0.0.1 / 0.0.0.0).
 *
 * Local endpoints are allowed to operate without an API key.
 */
export function isLocalMem0BaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return LOCAL_HOSTNAMES.includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Returns true when the plugin has sufficient auth to communicate with Mem0:
 * - either an API key is configured, or
 * - the base URL is local (no key required).
 */
export function hasMem0Auth(config: Pick<PluginConfig, 'mem0ApiKey' | 'mem0BaseUrl' | 'mem0Mode'>): boolean {
  if (config.mem0Mode === 'disabled') {
    return false;
  }

  if (config.mem0Mode === 'local') {
    return true;
  }

  if (config.mem0Mode === 'remote') {
    return Boolean(config.mem0ApiKey);
  }

  return Boolean(config.mem0ApiKey) || isLocalMem0BaseUrl(config.mem0BaseUrl);
}

/**
 * Build the HTTP headers required for Mem0 API calls.
 *
 * - With an API key: includes `Authorization: Token <key>`
 * - Without (local): omits the `Authorization` header
 * - When `json` is true: includes `Content-Type: application/json`
 */
export function buildMem0Headers(
  config: Pick<PluginConfig, 'mem0ApiKey'>,
  options?: { json?: boolean },
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options?.json) {
    headers['Content-Type'] = 'application/json';
  }
  if (config.mem0ApiKey) {
    headers['Authorization'] = `Token ${config.mem0ApiKey}`;
  }
  return headers;
}
