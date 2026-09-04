import { describe, expect, test } from 'bun:test';
import {
  evaluateExpression,
  expressionUsesBodyPhase,
  matchSrcIpRanges,
  validateExpression,
  validateSrcIpRanges,
} from './expression.ts';
import { buildRequestAttributes } from './request.ts';
import type { ExpressionEvaluation, RequestAttributeInput } from './types.ts';
import { ArmorError } from './types.ts';

const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.85 Safari/537.36';
const CHROME_JA3 = 'cd08e31494f9531f560d64caf9417541';
const CHROME_JA4 = 't13d1516h2_8daaf6152771_b0da82dd1658';

function evalExpr(
  expression: string,
  overrides: Partial<RequestAttributeInput> = {}
): ExpressionEvaluation {
  const input: RequestAttributeInput = {
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/',
    originIp: overrides.originIp ?? '127.0.0.1',
    headers: overrides.headers ?? {
      host: 'example.com',
      'user-agent': CHROME_USER_AGENT,
    },
    body: overrides.body ?? '',
    scheme: overrides.scheme ?? 'http',
    tlsJa3Fingerprint: overrides.tlsJa3Fingerprint ?? CHROME_JA3,
    tlsJa4Fingerprint: overrides.tlsJa4Fingerprint ?? CHROME_JA4,
  };

  if (overrides.query != null) input.query = overrides.query;
  if (overrides.asn != null) input.asn = overrides.asn;
  if (overrides.regionCode != null) input.regionCode = overrides.regionCode;
  if (overrides.sni != null) input.sni = overrides.sni;
  if (overrides.userIpRequestHeaders != null) {
    input.userIpRequestHeaders = overrides.userIpRequestHeaders;
  }
  if (overrides.params != null) input.params = overrides.params;
  if (overrides.jsonParsing != null) input.jsonParsing = overrides.jsonParsing;

  return evaluateExpression(expression, buildRequestAttributes(input));
}

function matched(expression: string, overrides?: Partial<RequestAttributeInput>): boolean {
  const result = evalExpr(expression, overrides);

  expect(result.ok).toBe(true);

  return result.ok ? result.matched : false;
}

describe('validateExpression limits', () => {
  test('rejects more than 5 subexpressions with the apply error', () => {
    const expr =
      "request.path == '/a' && request.path == '/b' && request.path == '/c' && request.path == '/d' && request.path == '/e' && request.path == '/f'";

    expect(() => validateExpression(expr)).toThrow(ArmorError);
    expect(() => validateExpression(expr)).toThrow('Expression count of 6 exceeded maximum of 5');
  });

  test('allows 5 comparisons and does not count && || !', () => {
    const expr =
      "!(request.path == '/a') && request.method == 'GET' && request.scheme == 'http' || request.path == '/b' && request.path == '/c'";

    expect(() => validateExpression(expr)).not.toThrow();
  });

  test('rejects a second matches() call', () => {
    const expr = "request.path.matches('a') && request.method.matches('G')";

    expect(() => validateExpression(expr)).toThrow(
      'only one matches() call is allowed per expression'
    );
  });

  test("rejects the in operator with undeclared reference to '@in'", () => {
    expect(() => validateExpression("request.method in ['GET', 'POST']")).toThrow(
      "undeclared reference to '@in'"
    );
  });

  test('rejects capturing groups and allows non-capturing and inline flags', () => {
    expect(() => validateExpression("request.path.matches('(admin)')")).toThrow(
      'regular expression capture groups are not allowed; use (?:...) instead'
    );
    expect(() => validateExpression("request.path.matches('(?:admin)')")).not.toThrow();
    expect(() =>
      validateExpression("request.headers['user-agent'].matches('(?i:chrome)')")
    ).not.toThrow();
  });

  test('rejects query_params and request.query map access', () => {
    expect(() => validateExpression('request.query_params()')).toThrow(
      "undeclared reference to 'query_params'"
    );
    expect(() => validateExpression('request.query.foo == "1"')).toThrow(
      'request.query is a string'
    );
  });

  test('rejects CEL macros', () => {
    expect(() => validateExpression("request.params.exists(k, k == 'x')")).toThrow(
      "undeclared reference to 'exists'"
    );
    expect(() => validateExpression('request.params.all(k, true)')).toThrow(
      "undeclared reference to 'all'"
    );
    expect(() => validateExpression('request.params.filter(k, true)')).toThrow(
      "undeclared reference to 'filter'"
    );
    expect(() => validateExpression('request.params.map(k, k)')).toThrow(
      "undeclared reference to 'map'"
    );
    expect(() => validateExpression('request.params.exists_one(k, true)')).toThrow(
      "undeclared reference to 'exists_one'"
    );
  });

  test('rejects expressions longer than 2048 characters', () => {
    const expr = `request.path == '${'a'.repeat(2040)}'`;

    expect(expr.length).toBeGreaterThan(2048);
    expect(() => validateExpression(expr)).toThrow('Expression exceeds maximum of 2048 characters');
  });

  test('rejects a subexpression longer than 1024 characters', () => {
    const expr = `request.path == '${'a'.repeat(1020)}'`;

    expect(() => validateExpression(expr)).toThrow(
      'Subexpression exceeds maximum of 1024 characters'
    );
  });
});

describe('evaluateExpression operators', () => {
  test('compares with == and !=', () => {
    expect(matched("request.method == 'GET'")).toBe(true);
    expect(matched("request.method == 'POST'")).toBe(false);
    expect(matched("request.method != 'POST'")).toBe(true);
  });

  test('applies ! && || with precedence ! > && > ||', () => {
    expect(matched("!request.path.startsWith('/admin') && request.method == 'GET'")).toBe(true);
    expect(matched("request.method == 'POST' || request.path == '/'")).toBe(true);
    expect(matched('false && true || true')).toBe(true);
    expect(matched('true || true && false')).toBe(true);
    expect(matched('!true || false')).toBe(false);
    expect(matched("!(request.method == 'POST')")).toBe(true);

    const bangThenCompare = evalExpr("!request.method == 'GET'");

    expect(bangThenCompare.ok).toBe(false);
  });

  test('string methods contains startsWith endsWith lower upper', () => {
    expect(matched("request.path.contains('/')")).toBe(true);
    expect(matched("request.path.startsWith('/')")).toBe(true);
    expect(matched("request.path.endsWith('/')")).toBe(true);
    expect(matched("request.headers['host'].lower() == 'example.com'")).toBe(true);
    expect(matched("request.headers['host'].upper() == 'EXAMPLE.COM'")).toBe(true);
  });

  test('matches() is RE2 search and does not require a full match', () => {
    expect(matched("request.path.matches('/')")).toBe(true);
    expect(matched("request.path.matches('^/$')")).toBe(true);
    expect(matched("request.path.matches('^/admin$')")).toBe(false);
    expect(matched("request.path.matches('admin')", { path: '/admin/users' })).toBe(true);
    expect(matched("request.path.matches('^admin$')", { path: '/admin/users' })).toBe(false);
  });
});

describe('evaluateExpression functions', () => {
  test('inIpRange matches IPv4 and IPv6 CIDRs', () => {
    expect(matched("inIpRange(origin.ip, '192.0.2.0/24')", { originIp: '192.0.2.10' })).toBe(true);
    expect(matched("inIpRange(origin.ip, '198.51.100.0/24')", { originIp: '192.0.2.10' })).toBe(
      false
    );
    expect(matched("inIpRange(origin.ip, '2001:db8::/32')", { originIp: '2001:db8::5' })).toBe(
      true
    );
  });

  test('has() guards missing map keys', () => {
    expect(matched("has(request.headers['user-agent'])")).toBe(true);
    expect(matched("has(request.headers['x-missing'])")).toBe(false);
    expect(
      matched("has(request.headers['x-missing']) && request.headers['x-missing'] == 'nope'")
    ).toBe(false);
  });

  test('write-time failures use INVALID_ARGUMENT', () => {
    let thrown: unknown;

    try {
      validateExpression("request.method in ['GET', 'POST']");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ArmorError);
    expect(thrown).toHaveProperty('status', 'INVALID_ARGUMENT');
  });

  test('missing map key is an error, not false', () => {
    const result = evalExpr("request.headers['x-missing'] == 'nope'");

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('no such key');
  });

  test('int() and size() with numeric comparison', () => {
    expect(
      matched("int(request.headers['content-length']) == 0", {
        headers: { 'content-length': '0' },
      })
    ).toBe(true);
    expect(matched('size(request.path) == 1')).toBe(true);
  });

  test('base64Decode, urlDecode, urlDecodeUni, utf8ToUnicode', () => {
    expect(
      matched("request.headers['x'].base64Decode().contains('myValue')", {
        headers: { x: btoa('xxmyValuexx') },
      })
    ).toBe(true);
    expect(
      matched("request.headers['cookie'].urlDecode().contains('<')", {
        headers: { cookie: '%3c' },
      })
    ).toBe(true);
    expect(
      matched("request.headers['cookie'].urlDecodeUni() == 'Match+Value'", {
        headers: { cookie: 'Match%u002BValue' },
      })
    ).toBe(true);
    expect(
      matched("request.headers['cookie'].utf8ToUnicode() == '%u00ac'", {
        headers: { cookie: '¬' },
      })
    ).toBe(true);
    expect(
      matched("request.headers['cookie'].utf8ToUnicode() == 'hello%u00ac'", {
        headers: { cookie: 'hello¬' },
      })
    ).toBe(true);
  });

  test('unimplemented evaluate* functions are valid syntax and return false', () => {
    const names = [
      "evaluatePreconfiguredWaf('xss-v422-stable')",
      "evaluatePreconfiguredExpr('xss-stable')",
      "evaluateAddressGroup('g', origin.ip)",
      "evaluateOrganizationAddressGroup('g', origin.ip)",
      "evaluateThreatIntelligence('iplist-known-malicious-ips')",
      "evaluateAdaptiveProtection('alert')",
      'evaluateAdaptiveProtectionAutoDeploy()',
    ];

    for (const expr of names) {
      expect(() => validateExpression(expr)).not.toThrow();
      expect(matched(expr)).toBe(false);
    }
  });

  test('origin attributes use supplied values', () => {
    expect(matched("origin.region_code == 'AU'", { regionCode: 'AU' })).toBe(true);
    expect(matched('origin.asn == 123', { asn: 123 })).toBe(true);
    expect(matched("origin.user_ip == '127.0.0.1'")).toBe(true);
  });
});

describe('SRC_IPS_V1', () => {
  test('validateSrcIpRanges caps at 10 and allows *', () => {
    expect(() => validateSrcIpRanges(['*'])).not.toThrow();
    expect(() =>
      validateSrcIpRanges(Array.from({ length: 10 }, (_, i) => `192.0.2.${i}`))
    ).not.toThrow();
    expect(() => validateSrcIpRanges(Array.from({ length: 11 }, (_, i) => `192.0.2.${i}`))).toThrow(
      'srcIpRanges exceeds maximum of 10'
    );
  });

  test('matchSrcIpRanges matches CIDRs and *', () => {
    expect(matchSrcIpRanges('192.0.2.8', ['10.0.0.0/8', '192.0.2.0/24'])).toBe(true);
    expect(matchSrcIpRanges('198.51.100.1', ['192.0.2.0/24'])).toBe(false);
    expect(matchSrcIpRanges('198.51.100.1', ['*'])).toBe(true);
  });
});

describe('body-phase detection', () => {
  test('flags request.body, request.params, and preconfigured WAF calls', () => {
    expect(expressionUsesBodyPhase("request.body.contains('x')")).toBe(true);
    expect(expressionUsesBodyPhase("request.params.category == 'electronics'")).toBe(true);
    expect(expressionUsesBodyPhase("request['body'].contains('x')")).toBe(true);
    expect(expressionUsesBodyPhase("request['params'].category == 'electronics'")).toBe(true);
    expect(expressionUsesBodyPhase("evaluatePreconfiguredWaf('xss-v422-stable')")).toBe(true);
    expect(expressionUsesBodyPhase("request.path == '/x'")).toBe(false);
  });
});
