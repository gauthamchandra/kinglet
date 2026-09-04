/**
 * Build the Cloud Armor request view from a plain HTTP description.
 *
 * origin.ip is the provided peer. X-Forwarded-For is a request header only.
 */

import type { JsonParsing, RequestAttributeInput, RequestAttributes } from './types.ts';
import { ArmorError } from './types.ts';

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isValidIp(value: string): boolean {
  return parseIpv4(value) != null || parseIpv6Groups(value) != null;
}

export function canonicalizeIp(value: string): string {
  const trimmed = stripZone(stripBrackets(value.trim()));
  const v4 = parseIpv4(trimmed);

  if (v4 != null) {
    return v4.join('.');
  }

  const groups = parseIpv6Groups(trimmed);

  if (groups == null) {
    throw new ArmorError(`Invalid IP address: ${value}`);
  }

  return formatIpv6(groups);
}

export function isValidCidr(range: string): boolean {
  return parseCidr(range) != null;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const parsed = parseCidr(cidr);

  if (parsed == null) {
    return false;
  }

  if (parsed.version === 4) {
    const addr = parseIpv4(stripBrackets(ip.trim()));

    if (addr == null) {
      return false;
    }

    const ipInt = ipv4ToInt(addr);
    const mask = parsed.prefix === 0 ? 0 : (~0 << (32 - parsed.prefix)) >>> 0;

    return (ipInt & mask) === (parsed.network & mask);
  }

  const groups = parseIpv6Groups(stripZone(stripBrackets(ip.trim())));

  if (groups == null) {
    return false;
  }

  const ipInt = ipv6ToBigint(groups);
  const mask =
    parsed.prefix === 0
      ? 0n
      : parsed.prefix >= 128
        ? (1n << 128n) - 1n
        : ((1n << BigInt(parsed.prefix)) - 1n) << BigInt(128 - parsed.prefix);

  return (ipInt & mask) === (parsed.network6 & mask);
}

export function parseFirstValidIp(value: string): string | null {
  const parts = value.split(',');

  for (const part of parts) {
    const candidate = stripBrackets(part.trim());

    if (candidate === '') {
      continue;
    }

    if (isValidIp(candidate)) {
      return canonicalizeIp(candidate);
    }
  }

  return null;
}

/**
 * Re-apply the inspection-size cap to request.body and rebuild request.params
 * from the truncated body so body-phase rules cannot see fields past the
 * window.
 */
export function withInspectedBody(
  attributes: RequestAttributes,
  maxBytes: number,
  jsonParsing: JsonParsing = 'DISABLED'
): RequestAttributes {
  const body = truncateUtf8(attributes.request.body, maxBytes);

  return {
    ...attributes,
    request: {
      ...attributes.request,
      body,
      params: mergeParams(
        attributes.request.query,
        body,
        attributes.request.headers,
        undefined,
        jsonParsing
      ),
    },
  };
}

export function buildRequestAttributes(input: RequestAttributeInput): RequestAttributes {
  const originIp = canonicalizeIp(input.originIp);
  const headers = normalizeHeaders(input.headers ?? {});
  const query = input.query ?? '';
  const body = input.body ?? '';
  const method = input.method.toUpperCase();
  const scheme = (input.scheme ?? 'http').toLowerCase();
  const params = mergeParams(query, body, headers, input.params, input.jsonParsing);
  const resolvedUserIp = resolveUserIp(headers, input.userIpRequestHeaders);

  const origin: RequestAttributes['origin'] = {
    ip: originIp,
    userIp: resolvedUserIp ?? originIp,
    userIpResolved: resolvedUserIp != null,
    regionCode: input.regionCode ?? '',
    asn: input.asn ?? 0,
    tlsJa3Fingerprint: input.tlsJa3Fingerprint ?? '',
    tlsJa4Fingerprint: input.tlsJa4Fingerprint ?? '',
  };

  return {
    origin,
    request: {
      headers,
      method,
      path: input.path,
      query,
      scheme,
      body,
      params,
    },
    sni: input.sni ?? '',
  };
}

function normalizeHeaders(
  input: Record<string, string | readonly string[] | undefined>
): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (rawValue == null) {
      continue;
    }

    const key = rawKey.toLowerCase();
    const piece = typeof rawValue === 'string' ? rawValue : rawValue.join(',');
    const existing = headers[key];

    if (existing != null) {
      headers[key] = `${existing},${piece}`;
    } else {
      headers[key] = piece;
    }
  }

  return headers;
}

function resolveUserIp(
  headers: Record<string, string>,
  names: readonly string[] | undefined
): string | null {
  if (names == null || names.length === 0) {
    return null;
  }

  for (const name of names) {
    const value = headers[name.toLowerCase()];

    if (value == null || value === '') {
      continue;
    }

    const parsed = parseFirstValidIp(value);

    if (parsed != null) {
      return parsed;
    }
  }

  return null;
}

function mergeParams(
  query: string,
  body: string,
  headers: Record<string, string>,
  explicit: Record<string, unknown> | undefined,
  jsonParsing: JsonParsing | undefined
): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  Object.assign(params, parseForm(stripQueryPrefix(query)));

  const mediaType = contentMediaType(headers['content-type'] ?? '');

  if (jsonParsingEnabled(jsonParsing) && mediaType === 'application/json') {
    Object.assign(params, parseJsonParams(body));
  } else if (mediaType === 'application/x-www-form-urlencoded') {
    Object.assign(params, parseForm(body));
  }

  if (explicit != null) {
    Object.assign(params, explicit);
  }

  return params;
}

function contentMediaType(contentType: string): string {
  const semicolon = contentType.indexOf(';');
  const type = semicolon === -1 ? contentType : contentType.substring(0, semicolon);

  return type.trim().toLowerCase();
}

function jsonParsingEnabled(jsonParsing: JsonParsing | undefined): boolean {
  return jsonParsing === 'STANDARD' || jsonParsing === 'STANDARD_WITH_GRAPHQL';
}

function stripQueryPrefix(query: string): string {
  return query.startsWith('?') ? query.substring(1) : query;
}

function parseForm(raw: string): Record<string, string> {
  const out: Record<string, string> = {};

  if (raw === '') {
    return out;
  }

  for (const part of raw.split('&')) {
    if (part === '') {
      continue;
    }

    const eq = part.indexOf('=');
    const rawName = eq === -1 ? part : part.substring(0, eq);
    const rawValue = eq === -1 ? '' : part.substring(eq + 1);

    out[decodeFormComponent(rawName)] = decodeFormComponent(rawValue);
  }

  return out;
}

function decodeFormComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function parseJsonParams(body: string): Record<string, string> {
  if (body.trim() === '') {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(body);

    return stringifyJsonObject(parsed);
  } catch {
    return parseTruncatedJsonObject(body);
  }
}

function stringifyJsonObject(parsed: unknown): Record<string, string> {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const asString = jsonParamString(value);

    if (asString != null) {
      out[key] = asString;
    }
  }

  return out;
}

function jsonParamString(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseTruncatedJsonObject(raw: string): Record<string, string> {
  const s = raw.trimStart();
  let i = 0;

  i = skipJsonWs(s, i);

  if (s[i] !== '{') {
    return {};
  }

  i++;

  const out: Record<string, string> = {};

  while (i < s.length) {
    i = skipJsonWs(s, i);

    if (i >= s.length || s[i] === '}') {
      break;
    }

    if (s[i] === ',') {
      i++;
      continue;
    }

    if (s[i] !== '"') {
      break;
    }

    const keySlice = sliceCompleteJsonString(s, i);

    if (keySlice == null) {
      break;
    }

    let key: string;

    try {
      key = JSON.parse(keySlice.text) as string;
    } catch {
      break;
    }

    i = skipJsonWs(s, keySlice.end);

    if (s[i] !== ':') {
      break;
    }

    i = skipJsonWs(s, i + 1);

    if (i >= s.length) {
      break;
    }

    const valueSlice = sliceCompleteJsonValue(s, i);

    if (valueSlice == null) {
      break;
    }

    i = valueSlice.end;

    const asString = jsonParamString(valueSlice.value);

    if (asString != null) {
      out[key] = asString;
    }
  }

  return out;
}

function sliceCompleteJsonString(s: string, start: number): { text: string; end: number } | null {
  const end = endOfJsonString(s, start);

  if (end == null) {
    return null;
  }

  return { text: s.substring(start, end), end };
}

function sliceCompleteJsonValue(s: string, start: number): { value: unknown; end: number } | null {
  const ch = s[start];

  if (ch === '"') {
    const end = endOfJsonString(s, start);

    if (end == null) {
      return null;
    }

    return parseJsonSlice(s, start, end);
  }

  if (ch === '{' || ch === '[') {
    const end = endOfJsonContainer(s, start);

    if (end == null) {
      return null;
    }

    return parseJsonSlice(s, start, end);
  }

  const litEnd = endOfJsonLiteral(s, start);

  if (litEnd == null) {
    return null;
  }

  const after = skipJsonWs(s, litEnd);

  if (after >= s.length) {
    return null;
  }

  const next = s[after];

  if (next !== ',' && next !== '}' && next !== ']') {
    return null;
  }

  return parseJsonSlice(s, start, litEnd);
}

function parseJsonSlice(
  s: string,
  start: number,
  end: number
): { value: unknown; end: number } | null {
  try {
    return { value: JSON.parse(s.substring(start, end)), end };
  } catch {
    return null;
  }
}

function endOfJsonString(s: string, start: number): number | null {
  let i = start + 1;

  while (i < s.length) {
    const ch = s[i];

    if (ch === '\\') {
      if (i + 1 >= s.length) {
        return null;
      }

      if (s[i + 1] === 'u') {
        if (i + 5 >= s.length) {
          return null;
        }

        i += 6;
        continue;
      }

      i += 2;
      continue;
    }

    if (ch === '"') {
      return i + 1;
    }

    i++;
  }

  return null;
}

function endOfJsonContainer(s: string, start: number): number | null {
  const stack: string[] = [];
  let i = start;

  while (i < s.length) {
    const ch = s[i];

    if (ch === '"') {
      const end = endOfJsonString(s, i);

      if (end == null) {
        return null;
      }

      i = end;
      continue;
    }

    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      i++;
      continue;
    }

    if (ch === '}' || ch === ']') {
      if (stack.length === 0 || stack[stack.length - 1] !== ch) {
        return null;
      }

      stack.pop();
      i++;

      if (stack.length === 0) {
        return i;
      }

      continue;
    }

    i++;
  }

  return null;
}

function endOfJsonLiteral(s: string, start: number): number | null {
  if (s.startsWith('true', start)) {
    return start + 4;
  }

  if (s.startsWith('false', start)) {
    return start + 5;
  }

  if (s.startsWith('null', start)) {
    return start + 4;
  }

  let i = start;

  if (s[i] === '-') {
    i++;
  }

  if (i >= s.length || !isDigit(s[i])) {
    return null;
  }

  if (s[i] === '0') {
    i++;
  } else {
    while (i < s.length && isDigit(s[i])) {
      i++;
    }
  }

  if (s[i] === '.') {
    i++;

    if (i >= s.length || !isDigit(s[i])) {
      return null;
    }

    while (i < s.length && isDigit(s[i])) {
      i++;
    }
  }

  if (s[i] === 'e' || s[i] === 'E') {
    i++;

    if (s[i] === '+' || s[i] === '-') {
      i++;
    }

    if (i >= s.length || !isDigit(s[i])) {
      return null;
    }

    while (i < s.length && isDigit(s[i])) {
      i++;
    }
  }

  return i;
}

function isDigit(ch: string | undefined): boolean {
  return ch != null && ch >= '0' && ch <= '9';
}

function skipJsonWs(s: string, start: number): number {
  let i = start;

  while (i < s.length) {
    const ch = s[i];

    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
      break;
    }

    i++;
  }

  return i;
}

function stripBrackets(value: string): string {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.substring(1, value.length - 1);
  }

  return value;
}

function stripZone(value: string): string {
  const pct = value.indexOf('%');

  return pct === -1 ? value : value.substring(0, pct);
}

function parseIpv4(value: string): [number, number, number, number] | null {
  const match = IPV4_RE.exec(value);

  if (match == null) {
    return null;
  }

  const octets: number[] = [];

  for (let i = 1; i <= 4; i++) {
    const raw = match[i];

    if (raw == null) {
      return null;
    }

    if (raw.length > 1 && raw.startsWith('0')) {
      return null;
    }

    const n = Number.parseInt(raw, 10);

    if (n > 255) {
      return null;
    }

    octets.push(n);
  }

  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

function parseIpv6Groups(value: string): number[] | null {
  const ip = stripZone(stripBrackets(value));

  if (ip.includes('.')) {
    return parseIpv6Mapped(ip);
  }

  if (ip.includes(':::') || ip.split('::').length > 2) {
    return null;
  }

  const compressed = ip.includes('::');

  if (!compressed) {
    const parts = ip.split(':');

    if (parts.length !== 8) {
      return null;
    }

    return parseHexGroups(parts);
  }

  const [leftRaw, rightRaw] = ip.split('::');
  const left = leftRaw === '' || leftRaw == null ? [] : leftRaw.split(':');
  const right = rightRaw === '' || rightRaw == null ? [] : rightRaw.split(':');

  if (left.some(p => p === '') || right.some(p => p === '')) {
    return null;
  }

  const missing = 8 - left.length - right.length;

  if (missing < 1) {
    return null;
  }

  const filled = [...left, ...Array.from({ length: missing }, () => '0'), ...right];

  return parseHexGroups(filled);
}

function parseIpv6Mapped(value: string): number[] | null {
  const lastColon = value.lastIndexOf(':');

  if (lastColon === -1) {
    return null;
  }

  const v4 = parseIpv4(value.substring(lastColon + 1));

  if (v4 == null) {
    return null;
  }

  const head = value.substring(0, lastColon);
  const prefix = parseIpv6Groups(`${head}:0:0`);

  if (prefix == null) {
    return null;
  }

  prefix[6] = (v4[0] << 8) | v4[1];
  prefix[7] = (v4[2] << 8) | v4[3];

  return prefix;
}

function parseHexGroups(parts: string[]): number[] | null {
  const groups: number[] = [];

  for (const part of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) {
      return null;
    }

    groups.push(Number.parseInt(part, 16));
  }

  if (groups.length !== 8) {
    return null;
  }

  return groups;
}

function formatIpv6(groups: number[]): string {
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const b6 = groups[6] ?? 0;
    const b7 = groups[7] ?? 0;

    return `::ffff:${(b6 >> 8) & 0xff}.${b6 & 0xff}.${(b7 >> 8) & 0xff}.${b7 & 0xff}`;
  }

  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;

  for (let i = 0; i <= 8; i++) {
    if (i < 8 && groups[i] === 0) {
      if (curStart === -1) {
        curStart = i;
        curLen = 1;
      } else {
        curLen++;
      }
    } else {
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }

      curStart = -1;
      curLen = 0;
    }
  }

  if (bestLen < 2) {
    return groups.map(g => g.toString(16)).join(':');
  }

  const head = groups
    .slice(0, bestStart)
    .map(g => g.toString(16))
    .join(':');
  const tail = groups
    .slice(bestStart + bestLen)
    .map(g => g.toString(16))
    .join(':');

  return `${head}::${tail}`;
}

function ipv4ToInt(octets: [number, number, number, number]): number {
  return (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

function ipv6ToBigint(groups: number[]): bigint {
  let n = 0n;

  for (const group of groups) {
    n = (n << 16n) + BigInt(group);
  }

  return n;
}

function parseCidr(
  cidr: string
):
  | { version: 4; network: number; prefix: number }
  | { version: 6; network6: bigint; prefix: number }
  | null {
  const trimmed = cidr.trim();
  const slash = trimmed.lastIndexOf('/');
  const addr = slash === -1 ? trimmed : trimmed.substring(0, slash);
  const prefixRaw = slash === -1 ? null : trimmed.substring(slash + 1);

  const v4 = parseIpv4(addr);

  if (v4 != null) {
    const prefix = parsePrefixLength(prefixRaw, 32);

    if (prefix == null) {
      return null;
    }

    return { version: 4, network: ipv4ToInt(v4), prefix };
  }

  const v6 = parseIpv6Groups(addr);

  if (v6 != null) {
    const prefix = parsePrefixLength(prefixRaw, 128);

    if (prefix == null) {
      return null;
    }

    return { version: 6, network6: ipv6ToBigint(v6), prefix };
  }

  return null;
}

function parsePrefixLength(raw: string | null, max: number): number | null {
  if (raw == null) {
    return max;
  }

  if (!/^\d+$/.test(raw)) {
    return null;
  }

  const prefix = Number.parseInt(raw, 10);

  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
    return null;
  }

  return prefix;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);

  if (bytes.length <= maxBytes) {
    return value;
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, maxBytes));
}
