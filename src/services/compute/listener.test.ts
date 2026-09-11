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

describe('buildRequestAttributesFromListenerRequest: ASN and region', () => {
  function input(headers: Record<string, string>) {
    return {
      method: 'GET',
      path: '/path',
      query: '',
      headers,
      tcpPeer: '127.0.0.1',
      body: '',
      scheme: 'http',
      userIpRequestHeaders: [],
    };
  }

  test('populates origin.asn and origin.regionCode from kinglet headers', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({
        'x-kinglet-origin-ip': '203.0.113.10',
        'x-kinglet-origin-asn': '15169',
        'x-kinglet-origin-region-code': 'US',
      })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.origin.asn).toBe(15169);
    expect(result.attributes.origin.regionCode).toBe('US');
  });

  test('strips ASN and region kinglet headers before CEL', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({
        'x-kinglet-origin-ip': '203.0.113.10',
        'x-kinglet-origin-asn': '15169',
        'x-kinglet-origin-region-code': 'US',
      })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.request.headers['x-kinglet-origin-asn']).toBeUndefined();
    expect(result.attributes.request.headers['x-kinglet-origin-region-code']).toBeUndefined();
    expect(result.attributes.request.headers['x-kinglet-origin-ip']).toBeUndefined();
  });

  test('defaults asn to 0 and region to empty when headers are absent', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-ip': '203.0.113.10' })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.origin.asn).toBe(0);
    expect(result.attributes.origin.regionCode).toBe('');
  });

  test('accepts explicit ASN 0 and empty region as unresolved', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({
        'x-kinglet-origin-ip': '203.0.113.10',
        'x-kinglet-origin-asn': '0',
        'x-kinglet-origin-region-code': '',
      })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.origin.asn).toBe(0);
    expect(result.attributes.origin.regionCode).toBe('');
  });

  test('uppercases a two-letter region code', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({
        'x-kinglet-origin-ip': '203.0.113.10',
        'x-kinglet-origin-region-code': 'us',
      })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.origin.regionCode).toBe('US');
  });

  test('allows ASN without a region header', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({
        'x-kinglet-origin-ip': '203.0.113.10',
        'x-kinglet-origin-asn': '15169',
      })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.origin.asn).toBe(15169);
    expect(result.attributes.origin.regionCode).toBe('');
  });

  test('returns error for a non-integer ASN', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-asn': 'not-an-asn' })
    );

    expect(result).toEqual({
      error: 'Invalid X-Kinglet-Origin-ASN value: not-an-asn',
    });
  });

  test('returns error for a negative ASN', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-asn': '-1' })
    );

    expect(result).toEqual({
      error: 'Invalid X-Kinglet-Origin-ASN value: -1',
    });
  });

  test('returns error for an ASN above uint32 max', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-asn': '4294967296' })
    );

    expect(result).toEqual({
      error: 'Invalid X-Kinglet-Origin-ASN value: 4294967296',
    });
  });

  test('accepts uint32 max ASN', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-asn': '4294967295' })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.origin.asn).toBe(4294967295);
  });

  test('returns error for a region that is not two letters', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-region-code': 'USA' })
    );

    expect(result).toEqual({
      error: 'Invalid X-Kinglet-Origin-Region-Code value: USA',
    });
  });
});

describe('buildRequestAttributesFromListenerRequest: JA3 and JA4', () => {
  const ja3 = 'e7d705a3286e19ea42f587a344ee6862';
  const ja4 = 't13d1516h2_8daaf6152771_b186095e22b6';

  function input(headers: Record<string, string>) {
    return {
      method: 'GET',
      path: '/path',
      query: '',
      headers,
      tcpPeer: '127.0.0.1',
      body: '',
      scheme: 'http',
      userIpRequestHeaders: [],
    };
  }

  test('populates JA3 and JA4 fingerprints from kinglet headers', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({
        'x-kinglet-origin-ip': '203.0.113.10',
        'x-kinglet-origin-ja3': ja3,
        'x-kinglet-origin-ja4': ja4,
      })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.origin.tlsJa3Fingerprint).toBe(ja3);
    expect(result.attributes.origin.tlsJa4Fingerprint).toBe(ja4);
  });

  test('strips JA3 and JA4 kinglet headers before CEL', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({
        'x-kinglet-origin-ja3': ja3,
        'x-kinglet-origin-ja4': ja4,
      })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.request.headers['x-kinglet-origin-ja3']).toBeUndefined();
    expect(result.attributes.request.headers['x-kinglet-origin-ja4']).toBeUndefined();
  });

  test('defaults fingerprints to empty when headers are absent', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-ip': '203.0.113.10' })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.origin.tlsJa3Fingerprint).toBe('');
    expect(result.attributes.origin.tlsJa4Fingerprint).toBe('');
  });

  test('accepts empty fingerprint headers as unresolved', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({
        'x-kinglet-origin-ja3': '',
        'x-kinglet-origin-ja4': '',
      })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.origin.tlsJa3Fingerprint).toBe('');
    expect(result.attributes.origin.tlsJa4Fingerprint).toBe('');
  });

  test('lowercases a JA3 hex fingerprint', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-ja3': ja3.toUpperCase() })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.origin.tlsJa3Fingerprint).toBe(ja3);
  });

  test('returns error for a JA3 that is not 32 hex characters', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-ja3': 'not-a-ja3' })
    );

    expect(result).toEqual({
      error: 'Invalid X-Kinglet-Origin-JA3 value: not-a-ja3',
    });
  });

  test('returns error for a JA4 that does not match the fingerprint shape', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-ja4': 'not-a-ja4' })
    );

    expect(result).toEqual({
      error: 'Invalid X-Kinglet-Origin-JA4 value: not-a-ja4',
    });
  });
});

describe('buildRequestAttributesFromListenerRequest: SNI', () => {
  function input(headers: Record<string, string>) {
    return {
      method: 'GET',
      path: '/path',
      query: '',
      headers,
      tcpPeer: '127.0.0.1',
      body: '',
      scheme: 'http',
      userIpRequestHeaders: [],
    };
  }

  test('populates sni from the kinglet header', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({
        host: 'app.example.com',
        'x-kinglet-origin-sni': 'cdn.example.com',
      })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.sni).toBe('cdn.example.com');
    expect(result.attributes.request.headers.host).toBe('app.example.com');
  });

  test('strips the SNI kinglet header before CEL', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-sni': 'cdn.example.com' })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.request.headers['x-kinglet-origin-sni']).toBeUndefined();
  });

  test('defaults sni to empty when the header is absent', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-ip': '203.0.113.10' })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.sni).toBe('');
  });

  test('accepts an empty SNI header as unresolved', () => {
    const result = buildRequestAttributesFromListenerRequest(input({ 'x-kinglet-origin-sni': '' }));

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.sni).toBe('');
  });

  test('lowercases the SNI hostname', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-sni': 'CDN.Example.COM' })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.sni).toBe('cdn.example.com');
  });

  test('does not treat Host as SNI', () => {
    const result = buildRequestAttributesFromListenerRequest(input({ host: 'app.example.com' }));

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.sni).toBe('');
    expect(result.attributes.request.headers.host).toBe('app.example.com');
  });

  test('returns error for a SNI that is not a hostname', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-sni': 'not a host' })
    );

    expect(result).toEqual({
      error: 'Invalid X-Kinglet-Origin-SNI value: not a host',
    });
  });

  test('strips one trailing FQDN dot before storing SNI', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-sni': 'cdn.example.com.' })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.sni).toBe('cdn.example.com');
  });

  test('returns error for a lone trailing dot', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-sni': '.' })
    );

    expect(result).toEqual({
      error: 'Invalid X-Kinglet-Origin-SNI value: .',
    });
  });

  test('returns error for a double trailing dot', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-origin-sni': 'cdn.example.com..' })
    );

    expect(result).toEqual({
      error: 'Invalid X-Kinglet-Origin-SNI value: cdn.example.com..',
    });
  });
});

describe('buildRequestAttributesFromListenerRequest: WAF and Adaptive Protection', () => {
  function input(headers: Record<string, string>) {
    return {
      method: 'GET',
      path: '/path',
      query: '',
      headers,
      tcpPeer: '127.0.0.1',
      body: '',
      scheme: 'http',
      userIpRequestHeaders: [],
    };
  }

  const exampleMatch = 'protocolattack-v33-stable/owasp-crs-v030301-id921110-protocolattack';

  test('parses X-Kinglet-Waf-Match into wafMatches', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-waf-match': exampleMatch })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.wafMatches).toEqual([
      {
        ruleSet: 'protocolattack-v33-stable',
        signatureId: 'owasp-crs-v030301-id921110-protocolattack',
      },
    ]);
  });

  test('splits comma-joined WAF matches and strips the kinglet header', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({
        'x-kinglet-waf-match':
          'protocolattack-v33-stable/owasp-crs-v030301-id921110-protocolattack, sqli-v33-stable/owasp-crs-v030301-id942100-sqli',
      })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.wafMatches).toEqual([
      {
        ruleSet: 'protocolattack-v33-stable',
        signatureId: 'owasp-crs-v030301-id921110-protocolattack',
      },
      { ruleSet: 'sqli-v33-stable', signatureId: 'owasp-crs-v030301-id942100-sqli' },
    ]);
    expect(result.attributes.request.headers['x-kinglet-waf-match']).toBeUndefined();
  });

  test('empty WAF header is no matches', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-waf-match': '  ' })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.wafMatches).toEqual([]);
  });

  test('returns error for a rule-set-only WAF header', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-waf-match': 'protocolattack-v33-stable' })
    );

    expect(result).toEqual({
      error: 'Invalid X-Kinglet-Waf-Match value: protocolattack-v33-stable',
    });
  });

  test('returns error for a WAF header with a sensitivity segment', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-waf-match': `${exampleMatch}/1` })
    );

    expect(result).toEqual({
      error: `Invalid X-Kinglet-Waf-Match value: ${exampleMatch}/1`,
    });
  });

  test('returns error for an empty WAF piece', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-waf-match': `${exampleMatch},` })
    );

    expect(result).toEqual({
      error: `Invalid X-Kinglet-Waf-Match value: ${exampleMatch},`,
    });
  });

  test('parses Adaptive Protection true/false and strips the header', () => {
    const enabled = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-adaptive-protection': 'TRUE' })
    );
    const disabled = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-adaptive-protection': 'false' })
    );

    if ('error' in enabled) {
      throw new Error(`Expected success, got error: ${enabled.error}`);
    }

    if ('error' in disabled) {
      throw new Error(`Expected success, got error: ${disabled.error}`);
    }

    expect(enabled.attributes.adaptiveProtectionMatch).toBe(true);
    expect(disabled.attributes.adaptiveProtectionMatch).toBe(false);
    expect(enabled.attributes.request.headers['x-kinglet-adaptive-protection']).toBeUndefined();
  });

  test('empty Adaptive Protection header is unset', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-adaptive-protection': '' })
    );

    if ('error' in result) {
      throw new Error(`Expected success, got error: ${result.error}`);
    }

    expect(result.attributes.adaptiveProtectionMatch).toBe(false);
  });

  test('returns error for a non-boolean Adaptive Protection value', () => {
    const result = buildRequestAttributesFromListenerRequest(
      input({ 'x-kinglet-adaptive-protection': 'yes' })
    );

    expect(result).toEqual({
      error: 'Invalid X-Kinglet-Adaptive-Protection value: yes',
    });
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

  test('unknown deny status is treated as 403', () => {
    const result: EvaluationResult = {
      enforced: { name: policyName, priority: 1000, action: 'deny(999)', outcome: 'DENY' },
    };

    const { status } = handleArmorDecision(result, policyName);

    expect(status).toBe(403);
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
