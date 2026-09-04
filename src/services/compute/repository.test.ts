/**
 * Compute repository persistence tests.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { StorageManager } from '@/core/storage/manager.ts';
import { ComputeRepository } from './repository.ts';
import type { GlobalOperationRecord, SecurityPolicyRecord } from './types.ts';
import {
  buildOperationSelfLink,
  buildSecurityPolicySelfLink,
  COMPUTE_KIND_OPERATION,
  COMPUTE_KIND_SECURITY_POLICY,
} from './types.ts';

let storage: StorageManager;
let repository: ComputeRepository;

beforeEach(async () => {
  storage = new StorageManager();
  await storage.initialize({ type: 'memory' });
  repository = new ComputeRepository(storage);
  await repository.initialize();
});

afterEach(async () => {
  await storage.close();
});

function policyData(
  project: string,
  name: string
): Omit<SecurityPolicyRecord, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name,
    project,
    selfLink: buildSecurityPolicySelfLink(project, name),
    fingerprint: 'fp',
    kind: COMPUTE_KIND_SECURITY_POLICY,
    creationTimestamp: '2026-09-04T00:00:00.000Z',
    rules: '[]',
    advancedOptionsConfig: null,
    extraFields: null,
  };
}

function operationData(
  project: string,
  operationId: string
): Omit<GlobalOperationRecord, 'id' | 'createdAt' | 'updatedAt'> {
  const now = '2026-09-04T00:00:00.000Z';

  return {
    operationId,
    project,
    name: operationId,
    status: 'DONE',
    operationType: 'insert',
    targetLink: buildSecurityPolicySelfLink(project, 'pol'),
    targetId: 'policy-1',
    kind: COMPUTE_KIND_OPERATION,
    selfLink: buildOperationSelfLink(project, operationId),
    insertTime: now,
    startTime: now,
    endTime: now,
  };
}

describe('ComputeRepository policies', () => {
  test('creates and reads a policy by project and name', async () => {
    const created = await repository.createPolicy(policyData('proj', 'pol'));
    const found = await repository.getPolicyByProjectAndName('proj', 'pol');

    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    expect(found?.name).toBe('pol');
    expect(found?.project).toBe('proj');
  });

  test('rejects a second policy with the same project and name', async () => {
    await repository.createPolicy(policyData('proj', 'pol'));

    const promise = repository.createPolicy(policyData('proj', 'pol'));

    await expect(promise).rejects.toThrow('already exists');
  });

  test('allows the same policy name in a different project', async () => {
    await repository.createPolicy(policyData('proj-a', 'pol'));
    const other = await repository.createPolicy(policyData('proj-b', 'pol'));

    expect(other.project).toBe('proj-b');
    expect(await repository.getPolicyByProjectAndName('proj-a', 'pol')).not.toBeNull();
    expect(await repository.getPolicyByProjectAndName('proj-b', 'pol')).not.toBeNull();
  });

  test('lists policies for one project and paginates', async () => {
    await repository.createPolicy(policyData('proj', 'a'));
    await repository.createPolicy(policyData('proj', 'b'));
    await repository.createPolicy(policyData('other', 'c'));

    const first = await repository.listPoliciesByProject('proj', 1);
    const second = await repository.listPoliciesByProject('proj', 1, first.nextPageToken);

    expect(first.items).toHaveLength(1);
    expect(first.nextPageToken).toBeTypeOf('string');
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.name).not.toBe(first.items[0]?.name);
    expect(second.nextPageToken).toBeUndefined();
  });

  test('updates and deletes a policy', async () => {
    const created = await repository.createPolicy(policyData('proj', 'pol'));
    const updated = await repository.updatePolicy(created.id, { fingerprint: 'next' });

    expect(updated?.fingerprint).toBe('next');

    const deleted = await repository.deletePolicy(created.id);

    expect(deleted).toBe(true);
    expect(await repository.getPolicyByProjectAndName('proj', 'pol')).toBeNull();
  });
});

describe('ComputeRepository operations', () => {
  test('creates and reads an operation by project and id', async () => {
    const created = await repository.createOperation(operationData('proj', 'op-1'));
    const found = await repository.getOperationByProjectAndId('proj', 'op-1');

    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    expect(found?.operationId).toBe('op-1');
    expect(found?.name).toBe('op-1');
    expect(found?.status).toBe('DONE');
  });

  test('returns null for an unknown operation', async () => {
    expect(await repository.getOperationByProjectAndId('proj', 'missing')).toBeNull();
  });
});
