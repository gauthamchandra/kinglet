/**
 * Listener adapter and local listener tests (TDD slice 3).
 *
 * Tests call buildRequestAttributesFromListenerRequest and handleArmorDecision
 * directly (unit tests) and also test policy resolution logic.
 */

import { describe, expect, test } from 'bun:test';
import type { EvaluationResult } from './armor/types.ts';
import {
  buildRequestAttributesFromListenerRequest,
  handleArmorDecision,
  jsonParsingFromPolicy,
  redirectTargetFromPolicy,
  selectPolicy,
  userIpRequestHeadersFromPolicy,
} from './listener.ts';
import { buildSecurityPolicySelfLink, type SecurityPolicyResponse } from './types.ts';

// ── buildRequestAttributesFromListenerRequest tests ──

describe('buildRequestAttributesFromListenerRequest: IP resolution', () => {
  test('uses X-Kinglet-Origin-IP as peer when valid', () => {
    const result = buildRequestAttributesFromListenerRequest({
      method: 'GET',
      path: '/admin',
      query: '',
      headers: { 'x-kinglet-origin-ip': '203.0.113.10' },
      tcpPeer: '127.0.0.1',
      body: '',
      scheme: 'http',
      userIpRequestHeaders: [],
    });

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.origin.ip).toBe('203.0.113.10');
  });

  test('strips x-kinglet-origin-ip from headers after parsing', () => {
    const result = buildRequestAttributesFromListenerRequest({
      method: 'GET',
      path: '/path',
      query: '',
      headers: { 'x-kinglet-origin-ip': '10.0.0.1' },
      tcpPeer: '127.0.0.1',
      body: '',
      scheme: 'http',
      userIpRequestHeaders: [],
    });

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.request.headers['x-kinglet-origin-ip']).toBeUndefined();
  });

  test('uses TCP peer when X-Kinglet-Origin-IP is absent', () => {
    const result = buildRequestAttributesFromListenerRequest({
      method: 'GET',
      path: '/path',
      query: '',
      headers: { host: 'app.example.com' },
      tcpPeer: '198.51.100.5',
      body: '',
      scheme: 'http',
      userIpRequestHeaders: [],
    });

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.origin.ip).toBe('198.51.100.5');
  });

  test('returns error for invalid X-Kinglet-Origin-IP', () => {
    const result = buildRequestAttributesFromListenerRequest({
      method: 'GET',
      path: '/path',
      query: '',
      headers: { 'x-kinglet-origin-ip': 'not-an-ip' },
      tcpPeer: '127.0.0.1',
      body: '',
      scheme: 'http',
      userIpRequestHeaders: [],
    });

    expect(result).toHaveProperty('error');
  });
});

describe('buildRequestAttributesFromListenerRequest: XFF rewriting', () => {
  test('appends peer to existing X-Forwarded-For', () => {
    const result = buildRequestAttributesFromListenerRequest({
      method: 'GET',
      path: '/path',
      query: '',
      headers: {
        'x-forwarded-for': '203.0.113.1',
        'x-kinglet-origin-ip': '10.0.0.1',
      },
      tcpPeer: '127.0.0.1',
      body: '',
      scheme: 'http',
      userIpRequestHeaders: [],
    });

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.request.headers['x-forwarded-for']).toBe('203.0.113.1, 10.0.0.1');
  });

  test('resolves origin.user_ip from userIpRequestHeaders after XFF rewrite', () => {
    const result = buildRequestAttributesFromListenerRequest({
      method: 'GET',
      path: '/path',
      query: '',
      headers: {
        'x-kinglet-origin-ip': '10.0.0.1',
        'true-client-ip': '198.51.100.9',
      },
      tcpPeer: '127.0.0.1',
      body: '',
      scheme: 'http',
      userIpRequestHeaders: ['True-Client-IP'],
    });

    expect(result).not.toHaveProperty('error');
    expect(
      (result as { attributes: { origin: { ip: string; userIp: string } } }).attributes.origin
        .userIp
    ).toBe('198.51.100.9');
    expect((result as { attributes: { origin: { ip: string } } }).attributes.origin.ip).toBe(
      '10.0.0.1'
    );
  });

  test('sets X-Forwarded-For to peer when no existing header', () => {
    const result = buildRequestAttributesFromListenerRequest({
      method: 'GET',
      path: '/path',
      query: '',
      headers: { 'x-kinglet-origin-ip': '10.0.0.1' },
      tcpPeer: '127.0.0.1',
      body: '',
      scheme: 'http',
      userIpRequestHeaders: [],
    });

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.request.headers['x-forwarded-for']).toBe('10.0.0.1');
  });
});

// ── handleArmorDecision: HTTP status mapping ──

describe('handleArmorDecision: status codes', () => {
  const policyName = 'test-policy';

  function makeResult(action: string, priority: number): EvaluationResult {
    return {
      enforced: {
        name: policyName,
        priority,
        action,
        outcome: action === 'allow' ? 'ALLOW' : 'DENY',
      },
    };
  }

  test('allow returns 200', () => {
    const { status, headers } = handleArmorDecision(makeResult('allow', 2147483647), policyName);

    expect(status).toBe(200);
    expect(headers['x-kinglet-enforced-action']).toBe('allow');
    expect(headers['x-kinglet-enforced-outcome']).toBe('ALLOW');
    expect(headers['x-kinglet-security-policy']).toBe(policyName);
    expect(headers['x-kinglet-enforced-priority']).toBe('2147483647');
  });

  test('deny(403) returns 403', () => {
    const result: EvaluationResult = {
      enforced: { name: policyName, priority: 1000, action: 'deny(403)', outcome: 'DENY' },
    };

    const { status } = handleArmorDecision(result, policyName);

    expect(status).toBe(403);
  });

  test('deny(404) returns 404', () => {
    const result: EvaluationResult = {
      enforced: { name: policyName, priority: 1000, action: 'deny(404)', outcome: 'DENY' },
    };

    const { status } = handleArmorDecision(result, policyName);

    expect(status).toBe(404);
  });

  test('deny(429) returns 429', () => {
    const result: EvaluationResult = {
      enforced: { name: policyName, priority: 1000, action: 'deny(429)', outcome: 'DENY' },
    };

    const { status } = handleArmorDecision(result, policyName);

    expect(status).toBe(429);
  });

  test('redirect returns 302 and Location from the rule target', () => {
    const result: EvaluationResult = {
      enforced: { name: policyName, priority: 50, action: 'redirect', outcome: 'REDIRECT' },
    };

    const { status, headers } = handleArmorDecision(
      result,
      policyName,
      'https://example.com/login'
    );

    expect(status).toBe(302);
    expect(headers.location).toBe('https://example.com/login');
    expect(headers['x-kinglet-enforced-action']).toBe('redirect');
    expect(headers['x-kinglet-enforced-outcome']).toBe('REDIRECT');
  });

  test('deny(502) returns 502', () => {
    const result: EvaluationResult = {
      enforced: { name: policyName, priority: 1000, action: 'deny(502)', outcome: 'DENY' },
    };

    const { status } = handleArmorDecision(result, policyName);

    expect(status).toBe(502);
  });

  test('preview headers included when preview matched', () => {
    const result: EvaluationResult = {
      enforced: { name: policyName, priority: 2147483647, action: 'allow', outcome: 'ALLOW' },
      preview: { name: policyName, priority: 750, action: 'deny(403)', outcome: 'DENY' },
    };

    const { headers } = handleArmorDecision(result, policyName);

    expect(headers['x-kinglet-preview-priority']).toBe('750');
    expect(headers['x-kinglet-preview-action']).toBe('deny(403)');
    expect(headers['x-kinglet-preview-outcome']).toBe('DENY');
  });

  test('no preview headers when no preview match', () => {
    const result: EvaluationResult = {
      enforced: { name: policyName, priority: 2147483647, action: 'allow', outcome: 'ALLOW' },
    };

    const { headers } = handleArmorDecision(result, policyName);

    expect(headers['x-kinglet-preview-priority']).toBeUndefined();
    expect(headers['x-kinglet-preview-action']).toBeUndefined();
    expect(headers['x-kinglet-preview-outcome']).toBeUndefined();
  });
});

// ── selectPolicy: policy resolution ──

describe('selectPolicy', () => {
  const makePolicy = (name: string, project = 'proj'): SecurityPolicyResponse => ({
    kind: 'compute#securityPolicy',
    id: `${project}-${name}`,
    creationTimestamp: new Date().toISOString(),
    name,
    selfLink: buildSecurityPolicySelfLink(project, name),
    fingerprint: 'abc',
    rules: [],
  });

  test('returns the defaultPolicy by name when set', () => {
    const policies = [makePolicy('pol1'), makePolicy('pol2')];

    const result = selectPolicy(policies, 'pol1');

    expect(result).not.toBeNull();
    if ('error' in result) throw new Error('expected policy');
    expect(result.name).toBe('pol1');
  });

  test('returns single policy when no defaultPolicy configured', () => {
    const policies = [makePolicy('only-one')];

    const result = selectPolicy(policies, undefined);

    expect(result).not.toBeNull();
    if ('error' in result) throw new Error('expected policy');
    expect(result.name).toBe('only-one');
  });

  test('returns error when multiple policies and no defaultPolicy', () => {
    const policies = [makePolicy('pol1'), makePolicy('pol2')];

    const result = selectPolicy(policies, undefined);

    expect(result).toHaveProperty('error');
  });

  test('returns error when zero policies', () => {
    const result = selectPolicy([], undefined);

    expect(result).toHaveProperty('error');
  });

  test('returns error when defaultPolicy name not found', () => {
    const policies = [makePolicy('pol1')];

    const result = selectPolicy(policies, 'nonexistent');

    expect(result).toHaveProperty('error');
  });

  test('returns error when defaultPolicy name matches more than one project', () => {
    const policies = [makePolicy('shared', 'proj-a'), makePolicy('shared', 'proj-b')];

    const result = selectPolicy(policies, 'shared');

    expect(result).toHaveProperty('error');
  });

  test('resolves a project-qualified defaultPolicy when names collide', () => {
    const policies = [makePolicy('shared', 'proj-a'), makePolicy('shared', 'proj-b')];

    const result = selectPolicy(policies, 'projects/proj-b/global/securityPolicies/shared');

    if ('error' in result) {
      throw new Error('expected policy');
    }

    expect(result.selfLink).toBe(buildSecurityPolicySelfLink('proj-b', 'shared'));
  });

  test('resolves defaultPolicy from a full selfLink', () => {
    const policies = [makePolicy('shared', 'proj-a'), makePolicy('shared', 'proj-b')];
    const selfLink = buildSecurityPolicySelfLink('proj-a', 'shared');

    const result = selectPolicy(policies, selfLink);

    if ('error' in result) {
      throw new Error('expected policy');
    }

    expect(result.selfLink).toBe(selfLink);
  });
});

describe('policy adapter helpers', () => {
  test('reads userIpRequestHeaders from advancedOptionsConfig', () => {
    const policy: SecurityPolicyResponse = {
      kind: 'compute#securityPolicy',
      id: '1',
      creationTimestamp: new Date().toISOString(),
      name: 'pol',
      selfLink: 'https://example.com/pol',
      fingerprint: 'abc',
      rules: [],
      advancedOptionsConfig: { userIpRequestHeaders: ['True-Client-IP', 'X-Forwarded-For'] },
    };

    expect(userIpRequestHeadersFromPolicy(policy)).toEqual(['True-Client-IP', 'X-Forwarded-For']);
    expect(userIpRequestHeadersFromPolicy({ ...policy, advancedOptionsConfig: undefined })).toEqual(
      []
    );
  });

  test('reads jsonParsing from advancedOptionsConfig', () => {
    const policy: SecurityPolicyResponse = {
      kind: 'compute#securityPolicy',
      id: '1',
      creationTimestamp: new Date().toISOString(),
      name: 'pol',
      selfLink: 'https://example.com/pol',
      fingerprint: 'abc',
      rules: [],
      advancedOptionsConfig: { jsonParsing: 'STANDARD' },
    };

    expect(jsonParsingFromPolicy(policy)).toBe('STANDARD');
    expect(jsonParsingFromPolicy({ ...policy, advancedOptionsConfig: undefined })).toBeUndefined();
    expect(
      jsonParsingFromPolicy({ ...policy, advancedOptionsConfig: { jsonParsing: 'nope' } })
    ).toBeUndefined();
  });

  test('reads redirect target from the matched rule', () => {
    const policy: SecurityPolicyResponse = {
      kind: 'compute#securityPolicy',
      id: '1',
      creationTimestamp: new Date().toISOString(),
      name: 'pol',
      selfLink: 'https://example.com/pol',
      fingerprint: 'abc',
      rules: [
        {
          priority: 50,
          action: 'redirect',
          redirectOptions: { type: 'EXTERNAL_302', target: 'https://example.com/login' },
        },
      ],
    };

    expect(redirectTargetFromPolicy(policy, 50)).toBe('https://example.com/login');
    expect(redirectTargetFromPolicy(policy, 100)).toBeUndefined();
  });
});

// ── Header strip: CEL cannot see kinglet header ──

describe('kinglet origin header is not visible to CEL', () => {
  test('x-kinglet-origin-ip is stripped before attributes are built', () => {
    const result = buildRequestAttributesFromListenerRequest({
      method: 'GET',
      path: '/',
      query: '',
      headers: { 'x-kinglet-origin-ip': '10.1.2.3', host: 'example.com' },
      tcpPeer: '127.0.0.1',
      body: '',
      scheme: 'http',
      userIpRequestHeaders: [],
    });

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(Object.hasOwn(result.attributes.request.headers, 'x-kinglet-origin-ip')).toBe(false);
  });
});

describe('jsonParsing through the listener adapter', () => {
  test('keeps JSON params out of request.params unless jsonParsing is STANDARD', () => {
    const disabled = buildRequestAttributesFromListenerRequest({
      method: 'POST',
      path: '/',
      query: '',
      headers: { 'content-type': 'application/json' },
      tcpPeer: '127.0.0.1',
      body: '{"city":"NewYork"}',
      scheme: 'http',
      userIpRequestHeaders: [],
    });
    const enabled = buildRequestAttributesFromListenerRequest({
      method: 'POST',
      path: '/',
      query: '',
      headers: { 'content-type': 'application/json' },
      tcpPeer: '127.0.0.1',
      body: '{"city":"NewYork","n":1}',
      scheme: 'http',
      userIpRequestHeaders: [],
      jsonParsing: 'STANDARD',
    });

    if ('error' in disabled) {
      throw new Error(`Expected success, got error: ${disabled.error}`);
    }

    if ('error' in enabled) {
      throw new Error(`Expected success, got error: ${enabled.error}`);
    }

    expect(disabled.attributes.request.params.city).toBeUndefined();
    expect(enabled.attributes.request.params.city).toBe('NewYork');
    expect(enabled.attributes.request.params.n).toBe('1');
  });
});
