/**
 * ACL Policy Service - business logic for Memorystore ACL policies and revisions
 */

import type { BaseRecord } from '@/core/storage/types.ts';
import type { AclPolicyRepository } from './acl-policy-repository.ts';
import type { OperationsStore } from './operations.ts';
import {
  type AclPolicyRecord,
  type AclPolicyResponse,
  type AclPolicyRevisionResponse,
  type AclRule,
  aclPolicyRecordToResponse,
  aclPolicyRequestToRecord,
  aclPolicyRevisionRecordToResponse,
  buildAclPolicyName,
  buildAclPolicyRevisionName,
  MemoryStoreError,
  type OperationResponse,
  parseAclPolicyName,
  parseAclPolicyRevisionName,
} from './types.ts';

export interface ListAclPoliciesResponse {
  aclPolicies: AclPolicyResponse[];
  nextPageToken?: string;
}

export interface ListAclPolicyRevisionsResponse {
  aclPolicyRevisions: AclPolicyRevisionResponse[];
  nextPageToken?: string;
}

export class AclPolicyService {
  private repo: AclPolicyRepository;
  private operationsStore: OperationsStore;

  constructor(repo: AclPolicyRepository, operationsStore: OperationsStore) {
    this.repo = repo;
    this.operationsStore = operationsStore;
  }

  async createAclPolicy(
    project: string,
    location: string,
    aclPolicyId: string,
    body: { rules?: AclRule[] }
  ): Promise<AclPolicyResponse> {
    const name = buildAclPolicyName(project, location, aclPolicyId);
    const existing = await this.repo.getAclPolicyByName(name);

    if (existing) {
      throw new MemoryStoreError('ALREADY_EXISTS', `AclPolicy ${name} already exists`, name);
    }

    const created = await this.repo.createAclPolicy(aclPolicyRequestToRecord(name, body));

    await this.snapshotRevision(created);

    return aclPolicyRecordToResponse(created);
  }

  async getAclPolicy(name: string): Promise<AclPolicyResponse> {
    const record = await this.getExistingAclPolicyOrThrow(name);

    return aclPolicyRecordToResponse(record);
  }

  async listAclPolicies(
    project: string,
    location: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListAclPoliciesResponse> {
    const result = await this.repo.listAclPolicies(project, location, pageSize, pageToken);

    const response: ListAclPoliciesResponse = {
      aclPolicies: result.aclPolicies.map(aclPolicyRecordToResponse),
    };

    if (result.nextPageToken) response.nextPageToken = result.nextPageToken;

    return response;
  }

  async updateAclPolicy(
    name: string,
    body: { rules?: AclRule[] },
    updateMask?: string
  ): Promise<OperationResponse> {
    await this.getExistingAclPolicyOrThrow(name);

    const maskedFields = updateMask
      ? updateMask.split(',').map(field => field.trim())
      : Object.keys(body);

    // `rules` is the only mutable AclPolicy field. An explicit updateMask
    // naming anything else is a client error worth surfacing (mirroring
    // InstanceService.buildInstanceUpdates); a stray key in a whole-resource
    // PATCH body with no mask is silently dropped instead.
    if (updateMask) {
      for (const field of maskedFields) {
        if ((field.split('.')[0] ?? field) !== 'rules') {
          throw new MemoryStoreError(
            'INVALID_ARGUMENT',
            `Field "${field}" is read-only or unknown and cannot be updated`
          );
        }
      }
    }

    const updates: Partial<Omit<AclPolicyRecord, keyof BaseRecord>> = {};
    const rulesChanged = maskedFields.includes('rules') && body.rules != null;

    if (rulesChanged) {
      updates.rules = JSON.stringify(body.rules);
      // A fresh etag per mutation is what makes the delete-time etag check
      // meaningful; reusing the create-time value lets a client delete using
      // an etag captured before any number of intervening updates.
      updates.etag = crypto.randomUUID();
    }

    const updated = await this.repo.updateAclPolicy(name, updates);

    // Snapshot only when something actually changed; a no-op PATCH otherwise
    // mints a revision identical to the current one, growing the revisions
    // table without bound.
    if (updated && rulesChanged) await this.snapshotRevision(updated);

    const { project, location } = parseAclPolicyName(name);

    return this.operationsStore.createOperation(
      project,
      location,
      name,
      'update',
      'AclPolicy',
      updated
        ? (aclPolicyRecordToResponse(updated) as unknown as Record<string, unknown>)
        : undefined
    );
  }

  async deleteAclPolicy(name: string, etag?: string): Promise<OperationResponse> {
    const existing = await this.getExistingAclPolicyOrThrow(name);

    // The document specifies ABORTED (409) for an etag mismatch, not
    // FAILED_PRECONDITION (400) — client retry policies key off the
    // distinction to decide whether to re-run a read-modify-write.
    if (etag && etag !== existing.etag) {
      throw new MemoryStoreError('ABORTED', `Etag mismatch for AclPolicy ${name}`, name);
    }

    await this.repo.deleteAclPolicy(name);

    const { project, location } = parseAclPolicyName(name);

    return this.operationsStore.createOperation(project, location, name, 'delete', 'AclPolicy');
  }

  async listAclPolicyRevisions(
    policyName: string,
    pageSize?: number,
    pageToken?: string
  ): Promise<ListAclPolicyRevisionsResponse> {
    const result = await this.repo.listRevisions(policyName, pageSize, pageToken);

    const response: ListAclPolicyRevisionsResponse = {
      aclPolicyRevisions: result.revisions.map(aclPolicyRevisionRecordToResponse),
    };

    if (result.nextPageToken) response.nextPageToken = result.nextPageToken;

    return response;
  }

  async getAclPolicyRevision(revisionName: string): Promise<AclPolicyRevisionResponse> {
    const { project, location, aclPolicy } = parseAclPolicyRevisionName(revisionName);
    const policyName = buildAclPolicyName(project, location, aclPolicy);
    const record = await this.repo.getRevisionByName(revisionName);

    if (!record || record.policyName !== policyName) {
      throw new MemoryStoreError(
        'NOT_FOUND',
        `AclPolicyRevision ${revisionName} not found`,
        revisionName
      );
    }

    return aclPolicyRevisionRecordToResponse(record);
  }

  private async snapshotRevision(policy: AclPolicyRecord): Promise<void> {
    const { project, location, aclPolicy } = parseAclPolicyName(policy.name);
    const revisionNumber = String((await this.repo.countRevisionsForPolicy(policy.name)) + 1);
    const revisionName = buildAclPolicyRevisionName(project, location, aclPolicy, revisionNumber);

    await this.repo.createRevision({
      name: revisionName,
      policyName: policy.name,
      revisionNumber,
      attachedInstances: JSON.stringify([]),
      snapshot: JSON.stringify(aclPolicyRecordToResponse(policy)),
    });
  }

  private async getExistingAclPolicyOrThrow(name: string): Promise<AclPolicyRecord> {
    const record = await this.repo.getAclPolicyByName(name);

    if (!record) {
      throw new MemoryStoreError('NOT_FOUND', `AclPolicy ${name} not found`, name);
    }

    return record;
  }
}
