import { beforeEach, describe, expect, test } from 'bun:test';
import { evaluate } from './evaluate.ts';
import { resetRateLimitStore, setRateLimitClock } from './rate-limit.ts';
import { buildRequestAttributes } from './request.ts';
import type {
  RequestAttributeInput,
  RequestAttributes,
  SecurityPolicy,
  SecurityPolicyRule,
} from './types.ts';
import { DEFAULT_RULE_PRIORITY } from './types.ts';

function attrs(overrides: Partial<RequestAttributeInput> = {}): RequestAttributes {
  const input: RequestAttributeInput = {
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/public',
    originIp: overrides.originIp ?? '127.0.0.1',
  };

  if (overrides.query != null) input.query = overrides.query;
  if (overrides.headers != null) input.headers = overrides.headers;
  if (overrides.body != null) input.body = overrides.body;
  if (overrides.scheme != null) input.scheme = overrides.scheme;
  if (overrides.asn != null) input.asn = overrides.asn;
  if (overrides.regionCode != null) input.regionCode = overrides.regionCode;
  if (overrides.params != null) input.params = overrides.params;
  if (overrides.jsonParsing != null) input.jsonParsing = overrides.jsonParsing;

  return buildRequestAttributes(input);
}

describe('evaluate', () => {
  beforeEach(() => {
    resetRateLimitStore();
  });

  test('sorts by lowest numeric priority and the first non-preview match wins', () => {
    const policy: SecurityPolicy = {
      name: 'example-policy',
      rules: [
        {
          priority: 2000,
          action: 'deny(404)',
          match: { expr: { expression: "request.path.startsWith('/')" } },
        },
        {
          priority: 1000,
          action: 'deny(403)',
          match: { expr: { expression: "request.path.startsWith('/admin')" } },
        },
        {
          priority: DEFAULT_RULE_PRIORITY,
          action: 'allow',
          match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['*'] } },
        },
      ],
    };

    const result = evaluate(policy, attrs({ path: '/admin' }));

    expect(result.enforced?.priority).toBe(1000);
    expect(result.enforced?.action).toBe('deny(403)');
    expect(result.enforced?.outcome).toBe('DENY');
    expect(result.enforced?.name).toBe('example-policy');
    expect(result.preview).toBeUndefined();
  });

  test('preview records the first preview match and continues to an enforced rule', () => {
    const policy: SecurityPolicy = {
      name: 'preview-policy',
      rules: [
        {
          priority: 750,
          action: 'deny(403)',
          preview: true,
          match: { expr: { expression: "request.path.startsWith('/admin')" } },
        },
        {
          priority: 1000,
          action: 'allow',
          match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['*'] } },
        },
      ],
    };

    const result = evaluate(policy, attrs({ path: '/admin' }));

    expect(result.preview?.priority).toBe(750);
    expect(result.preview?.action).toBe('deny(403)');
    expect(result.preview?.outcome).toBe('DENY');
    expect(result.enforced?.priority).toBe(1000);
    expect(result.enforced?.action).toBe('allow');
    expect(result.enforced?.outcome).toBe('ALLOW');
  });

  test('evaluates present rules when the default is omitted', () => {
    const policy: SecurityPolicy = {
      rules: [
        {
          priority: 10,
          action: 'deny(403)',
          match: { expr: { expression: "request.path == '/only'" } },
        },
      ],
    };

    const hit = evaluate(policy, attrs({ path: '/only' }));
    const miss = evaluate(policy, attrs({ path: '/other' }));

    expect(hit.enforced?.priority).toBe(10);
    expect(miss.enforced).toBeUndefined();
  });

  test('header-phase allow prevents a later body-phase deny', () => {
    const policy: SecurityPolicy = {
      name: 'phase-policy',
      rules: [
        {
          priority: 1000,
          action: 'deny(403)',
          match: { expr: { expression: "request.body.contains('evil')" } },
        },
        {
          priority: 2000,
          action: 'allow',
          match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['127.0.0.1'] } },
        },
      ],
    };

    const result = evaluate(policy, attrs({ body: 'evil' }));

    expect(result.enforced?.priority).toBe(2000);
    expect(result.enforced?.action).toBe('allow');
  });

  test('body-phase rules run after header misses, by priority', () => {
    const policy: SecurityPolicy = {
      rules: [
        {
          priority: 1000,
          action: 'deny(404)',
          match: { expr: { expression: "request.body.contains('two')" } },
        },
        {
          priority: 500,
          action: 'deny(403)',
          match: { expr: { expression: "request.body.contains('one')" } },
        },
        {
          priority: 100,
          action: 'deny(502)',
          match: { expr: { expression: "request.path == '/nope'" } },
        },
      ],
    };

    const result = evaluate(policy, attrs({ path: '/x', body: 'one and two' }));

    expect(result.enforced?.priority).toBe(500);
    expect(result.enforced?.action).toBe('deny(403)');
  });

  test('redirect matching in the body phase becomes deny(403)', () => {
    const policy: SecurityPolicy = {
      rules: [
        {
          priority: 1000,
          action: 'redirect',
          match: { expr: { expression: "request.body.contains('go')" } },
        },
      ],
    };

    const result = evaluate(policy, attrs({ body: 'go' }));

    expect(result.enforced?.action).toBe('deny(403)');
    expect(result.enforced?.outcome).toBe('DENY');
  });

  test('truncates request.body to requestBodyInspectionSize before body-phase match', () => {
    const marker = 'UNIQUE-TAIL';
    const policy: SecurityPolicy = {
      advancedOptionsConfig: { requestBodyInspectionSize: '8KB' },
      rules: [
        {
          priority: 1,
          action: 'deny(403)',
          match: { expr: { expression: `request.body.contains('${marker}')` } },
        },
      ],
    };

    const hidden = evaluate(policy, attrs({ body: `${'x'.repeat(8192)}${marker}` }));
    const visible = evaluate(policy, attrs({ body: `${'x'.repeat(10)}${marker}` }));

    expect(hidden.enforced).toBeUndefined();
    expect(visible.enforced?.action).toBe('deny(403)');
  });

  test('rebuilds request.params from the truncated body', () => {
    const policy: SecurityPolicy = {
      advancedOptionsConfig: { requestBodyInspectionSize: '8KB' },
      rules: [
        {
          priority: 1,
          action: 'deny(403)',
          match: { expr: { expression: "request.params.secret == 'UNIQUE-TAIL'" } },
        },
      ],
    };

    const hidden = evaluate(
      policy,
      attrs({
        method: 'POST',
        body: `${'x'.repeat(8192)}secret=UNIQUE-TAIL`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
    );
    const visible = evaluate(
      policy,
      attrs({
        method: 'POST',
        body: 'secret=UNIQUE-TAIL',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
    );
    const queryKept = evaluate(
      policy,
      attrs({
        method: 'POST',
        query: 'secret=UNIQUE-TAIL',
        body: 'x'.repeat(9000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
    );

    expect(hidden.enforced).toBeUndefined();
    expect(visible.enforced?.action).toBe('deny(403)');
    expect(queryKept.enforced?.action).toBe('deny(403)');
  });

  test('parses truncated JSON params only when jsonParsing is STANDARD', () => {
    const visible = '{"keep":"yes","cut":"';
    const rules: SecurityPolicyRule[] = [
      {
        priority: 1,
        action: 'deny(403)',
        match: { expr: { expression: "request.params.keep == 'yes'" } },
      },
      {
        priority: 2,
        action: 'deny(404)',
        match: { expr: { expression: "request.params.cut == 'UNIQUE-TAIL'" } },
      },
    ];
    const policy: SecurityPolicy = {
      advancedOptionsConfig: { requestBodyInspectionSize: '8KB', jsonParsing: 'STANDARD' },
      rules,
    };
    const disabled: SecurityPolicy = {
      advancedOptionsConfig: { requestBodyInspectionSize: '8KB' },
      rules,
    };

    const truncated = attrs({
      method: 'POST',
      body: `${visible}${'x'.repeat(8200)}UNIQUE-TAIL"}`,
      headers: { 'content-type': 'application/json' },
    });
    const complete = attrs({
      method: 'POST',
      body: '{"keep":"yes"}',
      headers: { 'Content-Type': 'Application/JSON' },
    });

    expect(evaluate(policy, truncated).enforced?.action).toBe('deny(403)');
    expect(evaluate(policy, complete).enforced?.action).toBe('deny(403)');
    expect(evaluate(disabled, complete).enforced).toBeUndefined();
  });

  test('expression evaluation error skips the rule and continues', () => {
    const policy: SecurityPolicy = {
      rules: [
        {
          priority: 100,
          action: 'deny(403)',
          match: { expr: { expression: "request.headers['x-missing'] == '1'" } },
        },
        {
          priority: 200,
          action: 'allow',
          match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['*'] } },
        },
      ],
    };

    const result = evaluate(policy, attrs());

    expect(result.enforced?.priority).toBe(200);
    expect(result.enforced?.action).toBe('allow');
  });

  test('SRC_IPS_V1 is header-phase and matches origin.ip', () => {
    const policy: SecurityPolicy = {
      rules: [
        {
          priority: 1,
          action: 'deny(403)',
          match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['198.51.100.0/24'] } },
        },
        {
          priority: DEFAULT_RULE_PRIORITY,
          action: 'allow',
          match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['*'] } },
        },
      ],
    };

    const denied = evaluate(policy, attrs({ originIp: '198.51.100.9' }));
    const allowed = evaluate(policy, attrs({ originIp: '192.0.2.10' }));

    expect(denied.enforced?.action).toBe('deny(403)');
    expect(allowed.enforced?.action).toBe('allow');
    expect(allowed.enforced?.priority).toBe(DEFAULT_RULE_PRIORITY);
  });

  test('headerAction on a throttle rule makes the rate-limit action inert', () => {
    const policy: SecurityPolicy = {
      name: 'inert',
      rules: [
        {
          priority: 100,
          action: 'throttle',
          headerAction: { requestHeadersToAdds: [{ headerName: 'x-a', headerValue: '1' }] },
          rateLimitOptions: {
            rateLimitThreshold: { count: 1, intervalSec: 60 },
            exceedAction: 'deny(429)',
          },
          match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['*'] } },
        },
      ],
    };

    expect(evaluate(policy, attrs()).enforced?.action).toBe('allow');
    expect(evaluate(policy, attrs()).enforced?.action).toBe('allow');
    expect(evaluate(policy, attrs()).enforced?.action).toBe('allow');
  });

  test('throttle exceedAction is returned after the threshold', () => {
    let now = 5_000_000;

    resetRateLimitStore();
    setRateLimitClock(() => now);

    const policy: SecurityPolicy = {
      name: 'rl',
      rules: [
        {
          priority: 50,
          action: 'throttle',
          rateLimitOptions: {
            rateLimitThreshold: { count: 1, intervalSec: 60 },
            exceedAction: 'deny(429)',
          },
          match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['*'] } },
        },
      ],
    };

    expect(evaluate(policy, attrs()).enforced?.action).toBe('allow');
    expect(evaluate(policy, attrs()).enforced?.action).toBe('deny(429)');
    expect(evaluate(policy, attrs()).enforced?.outcome).toBe('DENY');

    now += 60_000;

    expect(evaluate(policy, attrs()).enforced?.action).toBe('allow');
  });
});
