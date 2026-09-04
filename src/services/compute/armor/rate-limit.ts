/**
 * In-process Cloud Armor rate-limit counters.
 *
 * Counts are exact and single-process. Time is taken from an injectable clock
 * so tests do not depend on wall time.
 */

import { parseFirstValidIp } from './request.ts';
import type { RateLimitOptions, RequestAttributes } from './types.ts';
import { ArmorError, MAX_ENFORCE_ON_KEY_CONFIGS, RATE_LIMIT_KEY_VALUE_MAX_BYTES } from './types.ts';

export const VALID_INTERVAL_SEC = [
  10, 30, 60, 120, 180, 240, 300, 600, 900, 1200, 1800, 2700, 3600,
] as const;

export const VALID_BAN_DURATION_SEC = [
  60, 120, 180, 240, 300, 600, 900, 1200, 1800, 2700, 3600,
] as const;

const VALID_KEY_TYPES = new Set([
  'ALL',
  'IP',
  'XFF_IP',
  'USER_IP',
  'HTTP_HEADER',
  'HTTP_COOKIE',
  'HTTP_PATH',
  'SNI',
  'REGION_CODE',
  'TLS_JA3_FINGERPRINT',
  'TLS_JA4_FINGERPRINT',
]);

const REPEATABLE_KEY_TYPES = new Set(['HTTP_HEADER', 'HTTP_COOKIE']);

type Clock = () => number;

let nowFn: Clock = () => Date.now();

interface WindowCount {
  windowId: number;
  count: number;
}

const rateWindows = new Map<string, WindowCount>();
const banWindows = new Map<string, WindowCount>();
const bans = new Map<string, number>();

export function setRateLimitClock(clock: Clock): void {
  nowFn = clock;
}

export function resetRateLimitStore(): void {
  rateWindows.clear();
  banWindows.clear();
  bans.clear();
  nowFn = () => Date.now();
}

export function assertRateLimitActionTransition(from: string, to: string): void {
  if (from === 'rate_based_ban' && to === 'throttle') {
    throw new ArmorError(
      'Cannot change a rate_based_ban rule to throttle; delete and recreate the rule'
    );
  }
}

export function validateRateLimitOptions(action: string, options: RateLimitOptions): void {
  const threshold = options.rateLimitThreshold;

  if (threshold == null || threshold.count == null || threshold.intervalSec == null) {
    throw new ArmorError('rateLimitThreshold.count and intervalSec are required');
  }

  const maxCount = action === 'rate_based_ban' ? 10_000 : 1_000_000;

  if (!Number.isInteger(threshold.count) || threshold.count < 1 || threshold.count > maxCount) {
    throw new ArmorError(`rateLimitThreshold.count must be between 1 and ${maxCount}`);
  }

  if (!isValidInterval(threshold.intervalSec)) {
    throw new ArmorError(`Invalid intervalSec: ${threshold.intervalSec}`);
  }

  const configs = options.enforceOnKeyConfigs;

  if (configs != null && configs.length > 0) {
    if (options.enforceOnKey != null && options.enforceOnKey !== '') {
      throw new ArmorError('enforceOnKey must be empty when enforceOnKeyConfigs is set');
    }

    if (configs.length > MAX_ENFORCE_ON_KEY_CONFIGS) {
      throw new ArmorError(
        `A maximum of ${MAX_ENFORCE_ON_KEY_CONFIGS} enforceOnKeyConfigs are allowed`
      );
    }

    const seen = new Set<string>();

    for (const config of configs) {
      const type = config.enforceOnKeyType ?? '';

      validateKeyType(type);

      if (!REPEATABLE_KEY_TYPES.has(type) && seen.has(type)) {
        throw new ArmorError(`enforceOnKeyType ${type} may only appear once`);
      }

      seen.add(type);

      if (
        (type === 'HTTP_HEADER' || type === 'HTTP_COOKIE') &&
        (config.enforceOnKeyName == null || config.enforceOnKeyName === '')
      ) {
        throw new ArmorError(`${type} requires enforceOnKeyName`);
      }
    }
  } else if (options.enforceOnKey != null && options.enforceOnKey !== '') {
    validateKeyType(options.enforceOnKey);

    if (
      (options.enforceOnKey === 'HTTP_HEADER' || options.enforceOnKey === 'HTTP_COOKIE') &&
      (options.enforceOnKeyName == null || options.enforceOnKeyName === '')
    ) {
      throw new ArmorError(`${options.enforceOnKey} requires enforceOnKeyName`);
    }
  }

  if (action === 'rate_based_ban') {
    if (options.banDurationSec == null) {
      throw new ArmorError('banDurationSec is required for rate_based_ban');
    }

    if (!isValidBanDuration(options.banDurationSec)) {
      throw new ArmorError(`Invalid banDurationSec: ${options.banDurationSec}`);
    }

    if (options.banThreshold != null) {
      const ban = options.banThreshold;

      if (ban.count == null || ban.intervalSec == null) {
        throw new ArmorError('banThreshold.count and intervalSec are required');
      }

      if (!Number.isInteger(ban.count) || ban.count < 1 || ban.count > 10_000) {
        throw new ArmorError('banThreshold.count must be between 1 and 10000');
      }

      if (!isValidInterval(ban.intervalSec)) {
        throw new ArmorError(`Invalid banThreshold.intervalSec: ${ban.intervalSec}`);
      }
    }
  }
}

export function applyRateLimit(
  policyName: string,
  priority: number,
  action: 'throttle' | 'rate_based_ban',
  options: RateLimitOptions,
  attributes: RequestAttributes,
  mode: 'commit' | 'preview' = 'commit'
): string {
  const exceedAction = options.exceedAction ?? 'deny(429)';
  const conformAction = options.conformAction ?? 'allow';
  const threshold = options.rateLimitThreshold;
  const intervalSec = threshold?.intervalSec ?? 60;
  const limit = threshold?.count ?? 1;
  const clientKey = buildClientKey(options, attributes);
  const now = nowFn();
  const bucketKey = `${policyName}\0${priority}\0${clientKey}`;
  const banUntil = bans.get(bucketKey) ?? 0;

  if (banUntil > now) {
    return exceedAction;
  }

  const windowId = Math.floor(now / (intervalSec * 1000));
  const nextRateCount = nextCount(rateWindows, bucketKey, windowId);
  let wouldBan = false;

  if (action === 'rate_based_ban') {
    const banThreshold = options.banThreshold;

    if (banThreshold?.count != null && banThreshold.intervalSec != null) {
      const banWindowId = Math.floor(now / (banThreshold.intervalSec * 1000));
      const total = nextCount(banWindows, `banThresh\0${bucketKey}`, banWindowId);

      if (total > banThreshold.count) {
        wouldBan = true;
      }
    } else if (nextRateCount > limit) {
      wouldBan = true;
    }
  }

  if (mode === 'commit') {
    bump(rateWindows, bucketKey, windowId);

    if (action === 'rate_based_ban') {
      const banThreshold = options.banThreshold;

      if (banThreshold?.count != null && banThreshold.intervalSec != null) {
        const banWindowId = Math.floor(now / (banThreshold.intervalSec * 1000));

        bump(banWindows, `banThresh\0${bucketKey}`, banWindowId);
      }
    }

    if (wouldBan) {
      const durationSec = options.banDurationSec ?? 60;

      bans.set(bucketKey, now + durationSec * 1000);
    }
  }

  if (wouldBan || nextRateCount > limit) {
    return exceedAction;
  }

  return conformAction;
}

export function buildClientKey(options: RateLimitOptions, attributes: RequestAttributes): string {
  const configs = options.enforceOnKeyConfigs;

  if (configs != null && configs.length > 0) {
    return configs
      .map(config =>
        componentKey(config.enforceOnKeyType ?? 'ALL', config.enforceOnKeyName, attributes)
      )
      .join('|');
  }

  return componentKey(options.enforceOnKey ?? 'ALL', options.enforceOnKeyName, attributes);
}

function validateKeyType(type: string): void {
  if (!VALID_KEY_TYPES.has(type)) {
    throw new ArmorError(`Invalid enforceOnKeyType: ${type}`);
  }
}

function isValidInterval(value: number): boolean {
  return (VALID_INTERVAL_SEC as readonly number[]).includes(value);
}

function isValidBanDuration(value: number): boolean {
  return (VALID_BAN_DURATION_SEC as readonly number[]).includes(value);
}

function nextCount(store: Map<string, WindowCount>, key: string, windowId: number): number {
  const entry = store.get(key);

  if (entry == null || entry.windowId !== windowId) {
    return 1;
  }

  return entry.count + 1;
}

function bump(store: Map<string, WindowCount>, key: string, windowId: number): number {
  const entry = store.get(key);

  if (entry == null || entry.windowId !== windowId) {
    store.set(key, { windowId, count: 1 });

    return 1;
  }

  entry.count++;

  return entry.count;
}

function componentKey(
  type: string,
  name: string | undefined,
  attributes: RequestAttributes
): string {
  switch (type) {
    case 'ALL':
      return 'ALL';
    case 'IP':
      return `IP:${attributes.origin.ip}`;
    case 'USER_IP':
      if (!attributes.origin.userIpResolved) {
        return `IP:${attributes.origin.ip}`;
      }

      return `USER_IP:${truncateKey(attributes.origin.userIp)}`;
    case 'XFF_IP': {
      const header = attributes.request.headers['x-forwarded-for'];
      const hop = header != null ? parseFirstValidIp(header) : null;

      if (hop == null) {
        return `IP:${attributes.origin.ip}`;
      }

      return `XFF_IP:${truncateKey(hop)}`;
    }
    case 'HTTP_HEADER': {
      if (name == null || name === '') {
        return 'ALL';
      }

      const value = attributes.request.headers[name.toLowerCase()];

      if (value == null) {
        return 'ALL';
      }

      return `HTTP_HEADER:${name.toLowerCase()}=${truncateKey(value)}`;
    }
    case 'HTTP_COOKIE': {
      if (name == null || name === '') {
        return 'ALL';
      }

      const value = cookieValue(attributes.request.headers.cookie, name);

      if (value == null) {
        return 'ALL';
      }

      return `HTTP_COOKIE:${name}=${truncateKey(value)}`;
    }
    case 'HTTP_PATH':
      return `HTTP_PATH:${truncateKey(attributes.request.path)}`;
    case 'SNI':
      if (attributes.sni === '') {
        return 'ALL';
      }

      return `SNI:${truncateKey(attributes.sni)}`;
    case 'REGION_CODE':
      return `REGION_CODE:${truncateKey(attributes.origin.regionCode)}`;
    case 'TLS_JA3_FINGERPRINT':
      if (attributes.origin.tlsJa3Fingerprint === '') {
        return 'ALL';
      }

      return `JA3:${truncateKey(attributes.origin.tlsJa3Fingerprint)}`;
    case 'TLS_JA4_FINGERPRINT':
      if (attributes.origin.tlsJa4Fingerprint === '') {
        return 'ALL';
      }

      return `JA4:${truncateKey(attributes.origin.tlsJa4Fingerprint)}`;
    default:
      return 'ALL';
  }
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (header == null || header === '') {
    return null;
  }

  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    const key = eq === -1 ? trimmed : trimmed.substring(0, eq);
    const value = eq === -1 ? '' : trimmed.substring(eq + 1);

    if (key === name) {
      return value;
    }
  }

  return null;
}

function truncateKey(value: string): string {
  const bytes = new TextEncoder().encode(value);

  if (bytes.length <= RATE_LIMIT_KEY_VALUE_MAX_BYTES) {
    return value;
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.slice(0, RATE_LIMIT_KEY_VALUE_MAX_BYTES)
  );
}
