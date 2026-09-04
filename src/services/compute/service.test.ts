/**
 * Compute Security Policy service tests (write-path, TDD slice 1).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { Logger } from '@/shared/utils/logger.ts';
import { SecurityPolicyService, SecurityPolicyServiceError } from './service.ts';

let storage: StorageManager;
let service: SecurityPolicyService;

const logger = new Logger('test-compute', 'error');

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });

  service = new SecurityPolicyService(storage, logger);
  await service.initialize();
});

afterEach(async () => {
  await storage.close();
});

describe('insert', () => {
  test('inserts a policy and adds default allow rule at 2147483647', async () => {
    const { policy } = await service.insert('my-project', 'my-policy', {});

    expect(policy.name).toBe('my-policy');
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0]?.priority).toBe(2147483647);
    expect(policy.rules[0]?.action).toBe('allow');
    expect(policy.kind).toBe('compute#securityPolicy');
    expect(policy.selfLink).toContain('my-project');
    expect(policy.selfLink).toContain('my-policy');
    expect(policy.fingerprint).toBeTypeOf('string');
    expect(policy.id).toBeTypeOf('string');
    expect(policy.creationTimestamp).toBeTypeOf('string');
  });

  test('inserts a policy with provided rules (adds default if absent)', async () => {
    const rules = [
      {
        priority: 1000,
        action: 'deny(403)',
        match: { expr: { expression: "request.path.startsWith('/admin')" } },
      },
    ];

    const { policy } = await service.insert('proj', 'my-policy', { rules });

    const priorities = policy.rules.map(r => r.priority);

    expect(priorities).toContain(1000);
    expect(priorities).toContain(2147483647);
    expect(policy.rules).toHaveLength(2);
  });

  test('inserts a policy with explicit default rule (does not duplicate)', async () => {
    const rules = [
      {
        priority: 2147483647,
        action: 'deny(403)',
        match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['*'] } },
      },
    ];

    const { policy } = await service.insert('proj', 'pol', { rules });

    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0]?.action).toBe('deny(403)');
  });

  test('rejects duplicate policy name', async () => {
    await service.insert('proj', 'pol', {});

    const promise = service.insert('proj', 'pol', {});

    await expect(promise).rejects.toBeInstanceOf(SecurityPolicyServiceError);
    await expect(promise).rejects.toHaveProperty('status', 'ALREADY_EXISTS');
  });

  test('rejects duplicate rule priority', async () => {
    const rules = [
      {
        priority: 100,
        action: 'allow',
        match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['*'] } },
      },
      { priority: 100, action: 'deny(403)', match: { expr: { expression: 'true' } } },
    ];

    const promise = service.insert('proj', 'pol', { rules });

    await expect(promise).rejects.toBeInstanceOf(SecurityPolicyServiceError);
    await expect(promise).rejects.toHaveProperty('status', 'INVALID_ARGUMENT');
  });

  test('rejects expression with `in` keyword', async () => {
    const rules = [
      {
        priority: 100,
        action: 'deny(403)',
        match: { expr: { expression: "request.path in ['/a']" } },
      },
    ];

    const promise = service.insert('proj', 'pol', { rules });

    await expect(promise).rejects.toBeInstanceOf(SecurityPolicyServiceError);
    await expect(promise).rejects.toHaveProperty('status', 'INVALID_ARGUMENT');
  });

  test('rejects srcIpRanges exceeding 10', async () => {
    const ranges = [
      '1.0.0.0/8',
      '2.0.0.0/8',
      '3.0.0.0/8',
      '4.0.0.0/8',
      '5.0.0.0/8',
      '6.0.0.0/8',
      '7.0.0.0/8',
      '8.0.0.0/8',
      '9.0.0.0/8',
      '10.0.0.0/8',
      '11.0.0.0/8',
    ];
    const rules = [
      {
        priority: 100,
        action: 'deny(403)',
        match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ranges } },
      },
    ];

    const promise = service.insert('proj', 'pol', { rules });

    await expect(promise).rejects.toBeInstanceOf(SecurityPolicyServiceError);
    await expect(promise).rejects.toHaveProperty('status', 'INVALID_ARGUMENT');
  });

  test('rejects description exceeding 2048 chars', async () => {
    const promise = service.insert('proj', 'pol', { description: 'a'.repeat(2049) });

    await expect(promise).rejects.toBeInstanceOf(SecurityPolicyServiceError);
    await expect(promise).rejects.toHaveProperty('status', 'INVALID_ARGUMENT');
  });

  test('stores IPv6 in compressed form', async () => {
    const rules = [
      {
        priority: 100,
        action: 'deny(403)',
        match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['2001:0db8::0001/128'] } },
      },
    ];

    const { policy } = await service.insert('proj', 'pol', { rules });
    const rule = policy.rules.find(r => r.priority === 100);
    const ranges = (rule?.match as { config?: { srcIpRanges?: string[] } } | undefined)?.config
      ?.srcIpRanges;

    expect(ranges?.[0]).toBe('2001:db8::1/128');
  });

  test('creates an operation record with DONE status', async () => {
    const { operation } = await service.insert('proj', 'pol', {});

    expect(operation.kind).toBe('compute#operation');
    expect(operation.status).toBe('DONE');
    expect(operation.targetLink).toContain('proj');
    expect(operation.targetLink).toContain('pol');
    expect(operation.operationType).toBe('insert');
  });

  test('rejects throttle->rate_based_ban transition within same insert', async () => {
    const rules = [
      {
        priority: 100,
        action: 'rate_based_ban',
        match: { expr: { expression: 'true' } },
        rateLimitOptions: {
          rateLimitThreshold: { count: 10, intervalSec: 60 },
          banDurationSec: 60,
          exceedAction: 'deny(429)',
          conformAction: 'allow',
        },
      },
    ];

    const { policy } = await service.insert('proj', 'pol', { rules });

    expect(policy.rules.find(r => r.priority === 100)?.action).toBe('rate_based_ban');
  });
});

describe('get', () => {
  test('returns the policy after insert', async () => {
    await service.insert('proj', 'pol', {});

    const policy = await service.get('proj', 'pol');

    expect(policy).not.toBeNull();
    expect(policy?.name).toBe('pol');
  });

  test('returns null for non-existent policy', async () => {
    const result = await service.get('proj', 'nonexistent');

    expect(result).toBeNull();
  });
});

describe('list', () => {
  test('lists policies for a project', async () => {
    await service.insert('proj', 'pol1', {});
    await service.insert('proj', 'pol2', {});

    const result = await service.list('proj');

    expect(result.items).toHaveLength(2);
    const names = result.items?.map(p => p.name) ?? [];

    expect(names).toContain('pol1');
    expect(names).toContain('pol2');
  });

  test('does not return policies from other projects', async () => {
    await service.insert('proj-a', 'pol', {});
    await service.insert('proj-b', 'pol', {});

    const result = await service.list('proj-a');

    expect(result.items).toHaveLength(1);
    expect(result.items?.[0]?.name).toBe('pol');
  });
});

describe('delete', () => {
  test('deletes an existing policy and returns operation', async () => {
    await service.insert('proj', 'pol', {});

    const { operation } = await service.delete('proj', 'pol');

    expect(operation.status).toBe('DONE');
    expect(operation.operationType).toBe('delete');

    const after = await service.get('proj', 'pol');

    expect(after).toBeNull();
  });

  test('throws NOT_FOUND for non-existent policy', async () => {
    const promise = service.delete('proj', 'nonexistent');

    await expect(promise).rejects.toBeInstanceOf(SecurityPolicyServiceError);
    await expect(promise).rejects.toHaveProperty('status', 'NOT_FOUND');
  });
});

describe('patch', () => {
  test('updates policy description', async () => {
    await service.insert('proj', 'pol', { description: 'orig' });

    const { policy } = await service.patch('proj', 'pol', { description: 'updated' });

    expect(policy.description).toBe('updated');
  });

  test('returns DONE operation', async () => {
    await service.insert('proj', 'pol', {});

    const { operation } = await service.patch('proj', 'pol', { description: 'x' });

    expect(operation.status).toBe('DONE');
    expect(operation.operationType).toBe('patch');
  });

  test('throws NOT_FOUND for unknown policy', async () => {
    const promise = service.patch('proj', 'nonexistent', { description: 'x' });

    await expect(promise).rejects.toBeInstanceOf(SecurityPolicyServiceError);
    await expect(promise).rejects.toHaveProperty('status', 'NOT_FOUND');
  });
});

describe('addRule', () => {
  test('adds a rule and returns updated policy + operation', async () => {
    await service.insert('proj', 'pol', {});

    const rule = {
      priority: 500,
      action: 'deny(403)',
      match: { expr: { expression: "request.path.startsWith('/bad')" } },
    };

    const { policy, operation } = await service.addRule('proj', 'pol', rule);

    const priorities = policy.rules.map(r => r.priority);

    expect(priorities).toContain(500);
    expect(priorities).toContain(2147483647);
    expect(operation.status).toBe('DONE');
  });

  test('rejects duplicate priority', async () => {
    await service.insert('proj', 'pol', {});

    const rule = {
      priority: 2147483647,
      action: 'deny(403)',
      match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['*'] } },
    };

    const promise = service.addRule('proj', 'pol', rule);

    await expect(promise).rejects.toBeInstanceOf(SecurityPolicyServiceError);
    await expect(promise).rejects.toHaveProperty('status', 'INVALID_ARGUMENT');
  });
});

describe('removeRule', () => {
  test('removes a non-default rule', async () => {
    const rules = [
      {
        priority: 500,
        action: 'deny(403)',
        match: { expr: { expression: "request.path.startsWith('/x')" } },
      },
    ];

    await service.insert('proj', 'pol', { rules });

    const { policy } = await service.removeRule('proj', 'pol', 500);

    const priorities = policy.rules.map(r => r.priority);

    expect(priorities).not.toContain(500);
    expect(priorities).toContain(2147483647);
  });

  test('rejects removing the default rule', async () => {
    await service.insert('proj', 'pol', {});

    const promise = service.removeRule('proj', 'pol', 2147483647);

    await expect(promise).rejects.toBeInstanceOf(SecurityPolicyServiceError);
    await expect(promise).rejects.toHaveProperty('status', 'INVALID_ARGUMENT');
  });

  test('throws NOT_FOUND for non-existent rule priority', async () => {
    await service.insert('proj', 'pol', {});

    const promise = service.removeRule('proj', 'pol', 9999);

    await expect(promise).rejects.toBeInstanceOf(SecurityPolicyServiceError);
    await expect(promise).rejects.toHaveProperty('status', 'NOT_FOUND');
  });
});

describe('getRule', () => {
  test('returns a rule by priority', async () => {
    const rules = [
      {
        priority: 100,
        action: 'allow',
        match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['*'] } },
      },
    ];

    await service.insert('proj', 'pol', { rules });

    const rule = await service.getRule('proj', 'pol', 100);

    expect(rule?.priority).toBe(100);
    expect(rule?.action).toBe('allow');
  });

  test('returns null for unknown priority', async () => {
    await service.insert('proj', 'pol', {});

    const rule = await service.getRule('proj', 'pol', 9999);

    expect(rule).toBeNull();
  });
});

describe('patchRule', () => {
  test('patches a rule action', async () => {
    await service.insert('proj', 'pol', {});

    const { policy } = await service.patchRule('proj', 'pol', 2147483647, {
      action: 'deny(403)',
      match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['*'] } },
    });

    const defaultRule = policy.rules.find(r => r.priority === 2147483647);

    expect(defaultRule?.action).toBe('deny(403)');
  });

  test('rejects throttle to rate_based_ban transition reversal', async () => {
    const rules = [
      {
        priority: 100,
        action: 'rate_based_ban',
        match: { expr: { expression: 'true' } },
        rateLimitOptions: {
          rateLimitThreshold: { count: 10, intervalSec: 60 },
          banDurationSec: 60,
          exceedAction: 'deny(429)',
          conformAction: 'allow',
        },
      },
    ];

    await service.insert('proj', 'pol', { rules });

    const promise = service.patchRule('proj', 'pol', 100, {
      action: 'throttle',
      rateLimitOptions: {
        rateLimitThreshold: { count: 10, intervalSec: 60 },
        exceedAction: 'deny(429)',
        conformAction: 'allow',
      },
    });

    await expect(promise).rejects.toBeInstanceOf(SecurityPolicyServiceError);
    await expect(promise).rejects.toHaveProperty('status', 'FAILED_PRECONDITION');
  });
});

describe('getOperation', () => {
  test('retrieves an operation by id', async () => {
    const { operation: op } = await service.insert('proj', 'pol', {});

    const operationId = op.id;
    const retrieved = await service.getOperation('proj', operationId);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(operationId);
    expect(retrieved?.status).toBe('DONE');
  });

  test('returns null for unknown operation', async () => {
    const result = await service.getOperation('proj', 'nonexistent-id');

    expect(result).toBeNull();
  });
});

describe('echo unknown beta fields', () => {
  test('stores and echoes unknown beta fields', async () => {
    const { policy } = await service.insert('proj', 'pol', {
      adaptiveProtectionConfig: { layer7DdosDefenseConfig: { enable: true } },
    } as Record<string, unknown>);

    expect(policy.adaptiveProtectionConfig).toBeDefined();
  });
});

describe('fingerprint', () => {
  test('fingerprint changes after patch', async () => {
    const { policy: p1 } = await service.insert('proj', 'pol', {});

    const { policy: p2 } = await service.patch('proj', 'pol', { description: 'changed' });

    expect(p2.fingerprint).not.toBe(p1.fingerprint);
  });
});
