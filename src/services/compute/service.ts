/**
 * Compute security policy service — business rules, no HTTP.
 *
 * Wraps the armor engine validators so write-time errors match GCP apply.
 */

import type { StorageManager } from '@/core/storage/manager.ts';
import type { Logger } from '@/shared/utils/logger.ts';
import { validateExpression, validateSrcIpRanges } from './armor/expression.ts';
import { assertRateLimitActionTransition, validateRateLimitOptions } from './armor/rate-limit.ts';
import { canonicalizeIp } from './armor/request.ts';
import type { SecurityPolicyMatch, SecurityPolicyRule } from './armor/types.ts';
import { ArmorError, DEFAULT_RULE_PRIORITY } from './armor/types.ts';
import { ComputeRepository } from './repository.ts';
import type {
  GlobalOperationRecord,
  GlobalOperationResponse,
  SecurityPolicyRecord,
  SecurityPolicyResponse,
  SecurityPolicyRuleResponse,
} from './types.ts';
import {
  buildOperationName,
  buildOperationSelfLink,
  buildSecurityPolicySelfLink,
  COMPUTE_KIND_OPERATION,
  COMPUTE_KIND_SECURITY_POLICY,
  COMPUTE_KIND_SECURITY_POLICY_LIST,
} from './types.ts';

// ── Errors ──

export type ComputeErrorStatus =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'FAILED_PRECONDITION';

export class SecurityPolicyServiceError extends Error {
  readonly code: number;
  readonly status: ComputeErrorStatus;

  constructor(message: string, status: ComputeErrorStatus) {
    super(message);
    this.name = 'SecurityPolicyServiceError';
    this.status = status;
    this.code = statusToHttpCode(status);
  }
}

function statusToHttpCode(status: ComputeErrorStatus): number {
  switch (status) {
    case 'INVALID_ARGUMENT':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'ALREADY_EXISTS':
      return 409;
    case 'FAILED_PRECONDITION':
      return 400;
  }
}

// ── Known extra fields the Terraform provider sends ──

const KNOWN_POLICY_FIELDS = new Set([
  'name',
  'rules',
  'advancedOptionsConfig',
  'type',
  'recaptchaOptionsConfig',
]);

// ── Result types ──

export interface InsertResult {
  policy: SecurityPolicyResponse;
  operation: GlobalOperationResponse;
}

export interface PolicyResult {
  policy: SecurityPolicyResponse;
  operation: GlobalOperationResponse;
}

export interface ListResult {
  kind: string;
  items?: SecurityPolicyResponse[];
  nextPageToken?: string;
}

// ── Service ──

export class SecurityPolicyService {
  private repository: ComputeRepository;
  private logger: Logger;

  constructor(storage: StorageManager, logger: Logger) {
    this.repository = new ComputeRepository(storage);
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    await this.repository.initialize();
    this.logger.info('Compute SecurityPolicy service initialized');
  }

  async insert(
    project: string,
    name: string,
    body: Record<string, unknown>
  ): Promise<InsertResult> {
    const description = body.description as string | undefined;

    if (description != null && description.length > 2048) {
      throw new SecurityPolicyServiceError(
        'description exceeds maximum of 2048 characters',
        'INVALID_ARGUMENT'
      );
    }

    const rawRules = (body.rules as unknown[] | undefined) ?? [];
    const validatedRules = validateAndNormalizeRules(rawRules);

    const existing = await this.repository.getPolicyByProjectAndName(project, name);

    if (existing != null) {
      throw new SecurityPolicyServiceError(
        `The resource 'projects/${project}/global/securityPolicies/${name}' already exists`,
        'ALREADY_EXISTS'
      );
    }

    const now = new Date().toISOString();
    const policyId = generateId();
    const fingerprint = generateFingerprint();
    const selfLink = buildSecurityPolicySelfLink(project, name);

    const advancedOptionsConfig = extractAdvancedOptionsConfig(body);
    const extraFields = extractExtraFields(body);

    const record = await this.repository.createPolicy({
      name,
      project,
      selfLink,
      fingerprint,
      kind: COMPUTE_KIND_SECURITY_POLICY,
      creationTimestamp: now,
      rules: JSON.stringify(validatedRules),
      advancedOptionsConfig:
        advancedOptionsConfig != null ? JSON.stringify(advancedOptionsConfig) : null,
      extraFields: Object.keys(extraFields).length > 0 ? JSON.stringify(extraFields) : null,
    });

    const description2 = body.description as string | undefined;
    const operation = await this.createOperation(project, 'insert', selfLink, policyId, record.id);

    const policy = recordToResponse(record, description2);

    return { policy, operation };
  }

  async get(project: string, name: string): Promise<SecurityPolicyResponse | null> {
    const record = await this.repository.getPolicyByProjectAndName(project, name);

    if (record == null) {
      return null;
    }

    return recordToResponse(record);
  }

  async list(project: string, pageSize?: number, pageToken?: string): Promise<ListResult> {
    const result = await this.repository.listPoliciesByProject(project, pageSize, pageToken);

    const items = result.items.map(r => recordToResponse(r));

    const listResult: ListResult = { kind: COMPUTE_KIND_SECURITY_POLICY_LIST };

    if (items.length > 0) {
      listResult.items = items;
    }

    if (result.nextPageToken != null) {
      listResult.nextPageToken = result.nextPageToken;
    }

    return listResult;
  }

  async delete(project: string, name: string): Promise<PolicyResult> {
    const record = await this.repository.getPolicyByProjectAndName(project, name);

    if (record == null) {
      throw new SecurityPolicyServiceError(
        `The resource 'projects/${project}/global/securityPolicies/${name}' was not found`,
        'NOT_FOUND'
      );
    }

    await this.repository.deletePolicy(record.id);

    const operation = await this.createOperation(
      project,
      'delete',
      record.selfLink,
      record.id,
      record.id
    );

    const policy = recordToResponse(record);

    return { policy, operation };
  }

  async patch(project: string, name: string, body: Record<string, unknown>): Promise<PolicyResult> {
    const record = await this.repository.getPolicyByProjectAndName(project, name);

    if (record == null) {
      throw new SecurityPolicyServiceError(
        `The resource 'projects/${project}/global/securityPolicies/${name}' was not found`,
        'NOT_FOUND'
      );
    }

    const description = body.description as string | undefined;

    if (description != null && description.length > 2048) {
      throw new SecurityPolicyServiceError(
        'description exceeds maximum of 2048 characters',
        'INVALID_ARGUMENT'
      );
    }

    const updateData: Partial<Omit<SecurityPolicyRecord, 'id' | 'createdAt' | 'updatedAt'>> = {
      fingerprint: generateFingerprint(),
    };

    if (body.rules !== undefined) {
      const rawRules = body.rules as unknown[];
      const validatedRules = validateAndNormalizeRules(rawRules);

      updateData.rules = JSON.stringify(validatedRules);
    }

    if (body.advancedOptionsConfig !== undefined) {
      updateData.advancedOptionsConfig =
        body.advancedOptionsConfig != null ? JSON.stringify(body.advancedOptionsConfig) : null;
    }

    const extraFields = extractExtraFields(body);
    const existingExtra =
      record.extraFields != null ? (JSON.parse(record.extraFields) as Record<string, unknown>) : {};

    const mergedExtra = { ...existingExtra, ...extraFields };

    if (description !== undefined) {
      mergedExtra.description = description;
    }

    updateData.extraFields =
      Object.keys(mergedExtra).length > 0 ? JSON.stringify(mergedExtra) : null;

    const updated = await this.repository.updatePolicy(record.id, updateData);

    if (updated == null) {
      throw new SecurityPolicyServiceError(`Policy ${name} disappeared during patch`, 'NOT_FOUND');
    }

    const operation = await this.createOperation(
      project,
      'patch',
      record.selfLink,
      record.id,
      record.id
    );

    const policy = recordToResponse(updated, description ?? getDescription(record));

    return { policy, operation };
  }

  async addRule(
    project: string,
    name: string,
    ruleBody: Record<string, unknown>
  ): Promise<PolicyResult> {
    const record = await this.repository.getPolicyByProjectAndName(project, name);

    if (record == null) {
      throw new SecurityPolicyServiceError(
        `The resource 'projects/${project}/global/securityPolicies/${name}' was not found`,
        'NOT_FOUND'
      );
    }

    const existingRules = JSON.parse(record.rules) as SecurityPolicyRule[];
    const newRule = validateSingleRule(ruleBody);

    const conflict = existingRules.find(r => r.priority === newRule.priority);

    if (conflict != null) {
      throw new SecurityPolicyServiceError(
        `Rule with priority ${newRule.priority} already exists`,
        'INVALID_ARGUMENT'
      );
    }

    const updatedRules = [...existingRules, newRule];

    const updated = await this.repository.updatePolicy(record.id, {
      rules: JSON.stringify(updatedRules),
      fingerprint: generateFingerprint(),
    });

    if (updated == null) {
      throw new SecurityPolicyServiceError(
        `Policy ${name} disappeared during addRule`,
        'NOT_FOUND'
      );
    }

    const operation = await this.createOperation(
      project,
      'addRule',
      record.selfLink,
      record.id,
      record.id
    );

    return { policy: recordToResponse(updated), operation };
  }

  async removeRule(project: string, name: string, priority: number): Promise<PolicyResult> {
    const record = await this.repository.getPolicyByProjectAndName(project, name);

    if (record == null) {
      throw new SecurityPolicyServiceError(
        `The resource 'projects/${project}/global/securityPolicies/${name}' was not found`,
        'NOT_FOUND'
      );
    }

    if (priority === DEFAULT_RULE_PRIORITY) {
      throw new SecurityPolicyServiceError(
        'Cannot delete the default rule (priority 2147483647)',
        'INVALID_ARGUMENT'
      );
    }

    const existingRules = JSON.parse(record.rules) as SecurityPolicyRule[];
    const idx = existingRules.findIndex(r => r.priority === priority);

    if (idx === -1) {
      throw new SecurityPolicyServiceError(`No rule found with priority ${priority}`, 'NOT_FOUND');
    }

    const updatedRules = existingRules.filter(r => r.priority !== priority);

    const updated = await this.repository.updatePolicy(record.id, {
      rules: JSON.stringify(updatedRules),
      fingerprint: generateFingerprint(),
    });

    if (updated == null) {
      throw new SecurityPolicyServiceError(
        `Policy ${name} disappeared during removeRule`,
        'NOT_FOUND'
      );
    }

    const operation = await this.createOperation(
      project,
      'removeRule',
      record.selfLink,
      record.id,
      record.id
    );

    return { policy: recordToResponse(updated), operation };
  }

  async getRule(
    project: string,
    name: string,
    priority: number
  ): Promise<SecurityPolicyRuleResponse | null> {
    const record = await this.repository.getPolicyByProjectAndName(project, name);

    if (record == null) {
      return null;
    }

    const rules = JSON.parse(record.rules) as SecurityPolicyRule[];
    const rule = rules.find(r => r.priority === priority);

    if (rule == null) {
      return null;
    }

    return rule as SecurityPolicyRuleResponse;
  }

  async patchRule(
    project: string,
    name: string,
    priority: number,
    ruleBody: Record<string, unknown>
  ): Promise<PolicyResult> {
    const record = await this.repository.getPolicyByProjectAndName(project, name);

    if (record == null) {
      throw new SecurityPolicyServiceError(
        `The resource 'projects/${project}/global/securityPolicies/${name}' was not found`,
        'NOT_FOUND'
      );
    }

    const existingRules = JSON.parse(record.rules) as SecurityPolicyRule[];
    const existing = existingRules.find(r => r.priority === priority);

    if (existing == null) {
      throw new SecurityPolicyServiceError(`No rule found with priority ${priority}`, 'NOT_FOUND');
    }

    const newAction = ruleBody.action as string | undefined;

    if (newAction != null && existing.action !== newAction) {
      try {
        assertRateLimitActionTransition(existing.action, newAction);
      } catch (err) {
        if (err instanceof ArmorError) {
          throw new SecurityPolicyServiceError(err.message, 'FAILED_PRECONDITION');
        }

        throw err;
      }
    }

    const patchedRule = validateSingleRule({ ...existing, ...ruleBody });
    const updatedRules = existingRules.map(r => (r.priority === priority ? patchedRule : r));

    const updated = await this.repository.updatePolicy(record.id, {
      rules: JSON.stringify(updatedRules),
      fingerprint: generateFingerprint(),
    });

    if (updated == null) {
      throw new SecurityPolicyServiceError(
        `Policy ${name} disappeared during patchRule`,
        'NOT_FOUND'
      );
    }

    const operation = await this.createOperation(
      project,
      'patchRule',
      record.selfLink,
      record.id,
      record.id
    );

    return { policy: recordToResponse(updated), operation };
  }

  async setLabels(project: string, name: string): Promise<{ operation: GlobalOperationResponse }> {
    const record = await this.repository.getPolicyByProjectAndName(project, name);

    if (record == null) {
      throw new SecurityPolicyServiceError(
        `The resource 'projects/${project}/global/securityPolicies/${name}' was not found`,
        'NOT_FOUND'
      );
    }

    const operation = await this.createOperation(
      project,
      'setLabels',
      record.selfLink,
      record.id,
      record.id
    );

    return { operation };
  }

  async getOperation(
    project: string,
    operationId: string
  ): Promise<GlobalOperationResponse | null> {
    const record = await this.repository.getOperationByProjectAndId(project, operationId);

    if (record == null) {
      return null;
    }

    return operationRecordToResponse(record);
  }

  private async createOperation(
    project: string,
    operationType: string,
    targetLink: string,
    targetId: string,
    _recordId: string
  ): Promise<GlobalOperationResponse> {
    const operationId = generateId();
    const now = new Date().toISOString();
    const operationSelfLink = buildOperationSelfLink(project, operationId);
    const operationName = buildOperationName(project, operationId);

    const record = await this.repository.createOperation({
      operationId,
      project,
      name: operationName,
      status: 'DONE',
      operationType,
      targetLink,
      targetId,
      kind: COMPUTE_KIND_OPERATION,
      selfLink: operationSelfLink,
      insertTime: now,
      startTime: now,
      endTime: now,
    });

    return operationRecordToResponse(record);
  }
}

// ── Helpers ──

function generateId(): string {
  return String(Math.floor(Math.random() * 1e15) + Date.now());
}

function generateFingerprint(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);

  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function validateAndNormalizeRules(rawRules: unknown[]): SecurityPolicyRule[] {
  const rules: SecurityPolicyRule[] = [];

  for (const raw of rawRules) {
    const rule = validateSingleRule(raw as Record<string, unknown>);

    rules.push(rule);
  }

  const priorities = new Set<number>();

  for (const rule of rules) {
    if (priorities.has(rule.priority)) {
      throw new SecurityPolicyServiceError(
        `Two rules cannot share priority ${rule.priority}`,
        'INVALID_ARGUMENT'
      );
    }

    priorities.add(rule.priority);
  }

  const hasDefault = rules.some(r => r.priority === DEFAULT_RULE_PRIORITY);

  if (!hasDefault) {
    rules.push({
      priority: DEFAULT_RULE_PRIORITY,
      action: 'allow',
      description: 'default allow rule',
      match: { versionedExpr: 'SRC_IPS_V1', config: { srcIpRanges: ['*'] } },
    });
  }

  return rules;
}

function validateSingleRule(raw: Record<string, unknown>): SecurityPolicyRule {
  const priority = raw.priority as number;

  if (!Number.isInteger(priority) || priority < 0 || priority > 2147483647) {
    throw new SecurityPolicyServiceError(
      `Invalid priority: ${priority}. Must be an integer in [0, 2147483647]`,
      'INVALID_ARGUMENT'
    );
  }

  const action = raw.action as string | undefined;

  if (action == null || action === '') {
    throw new SecurityPolicyServiceError('Rule action is required', 'INVALID_ARGUMENT');
  }

  const description = raw.description as string | undefined;

  if (description != null && description.length > 2048) {
    throw new SecurityPolicyServiceError(
      'Rule description exceeds maximum of 2048 characters',
      'INVALID_ARGUMENT'
    );
  }

  const match = raw.match as Record<string, unknown> | undefined;

  if (match != null) {
    validateMatch(match, action);
  }

  if ((action === 'throttle' || action === 'rate_based_ban') && raw.rateLimitOptions != null) {
    try {
      validateRateLimitOptions(action, raw.rateLimitOptions as Record<string, unknown>);
    } catch (err) {
      if (err instanceof ArmorError) {
        throw new SecurityPolicyServiceError(err.message, 'INVALID_ARGUMENT');
      }

      throw err;
    }
  }

  const rule: SecurityPolicyRule = {
    priority,
    action,
  };

  if (description != null) rule.description = description;

  if (match != null) {
    const normalizedMatch = normalizeMatch(match);

    if (normalizedMatch != null) {
      rule.match = normalizedMatch;
    }
  }

  if (raw.rateLimitOptions != null) {
    rule.rateLimitOptions = raw.rateLimitOptions as NonNullable<
      SecurityPolicyRule['rateLimitOptions']
    >;
  }

  if (raw.headerAction != null) {
    rule.headerAction = raw.headerAction as NonNullable<SecurityPolicyRule['headerAction']>;
  }

  if (raw.redirectOptions != null) {
    rule.redirectOptions = raw.redirectOptions as NonNullable<
      SecurityPolicyRule['redirectOptions']
    >;
  }

  if (raw.preview != null) rule.preview = raw.preview as boolean;

  return rule;
}

function validateMatch(match: Record<string, unknown>, _action: string): void {
  const versionedExpr = match.versionedExpr as string | undefined;
  const expr = match.expr as Record<string, unknown> | undefined;

  if (versionedExpr === 'SRC_IPS_V1') {
    const config = match.config as Record<string, unknown> | undefined;
    const srcIpRanges = config?.srcIpRanges as string[] | undefined;

    if (srcIpRanges != null) {
      try {
        validateSrcIpRanges(srcIpRanges);
      } catch (err) {
        if (err instanceof ArmorError) {
          throw new SecurityPolicyServiceError(err.message, 'INVALID_ARGUMENT');
        }

        throw err;
      }
    }
  } else if (expr != null) {
    const expression = expr.expression as string | undefined;

    if (expression != null) {
      try {
        validateExpression(expression);
      } catch (err) {
        if (err instanceof ArmorError) {
          throw new SecurityPolicyServiceError(err.message, 'INVALID_ARGUMENT');
        }

        throw err;
      }
    }
  }
}

function normalizeMatch(match: Record<string, unknown>): SecurityPolicyMatch | null {
  const versionedExpr = match.versionedExpr as string | undefined;

  if (versionedExpr === 'SRC_IPS_V1') {
    const config = match.config as Record<string, unknown> | undefined;
    const rawRanges = config?.srcIpRanges as string[] | undefined;

    if (rawRanges != null) {
      const normalizedRanges = rawRanges.map(range => normalizeCidr(range));

      return {
        versionedExpr: 'SRC_IPS_V1',
        config: { srcIpRanges: normalizedRanges },
      };
    }
  }

  return match as SecurityPolicyMatch;
}

function normalizeCidr(range: string): string {
  if (range === '*') {
    return range;
  }

  const slash = range.lastIndexOf('/');
  const ip = slash === -1 ? range : range.substring(0, slash);
  const prefix = slash === -1 ? '' : range.substring(slash);

  try {
    return `${canonicalizeIp(ip)}${prefix}`;
  } catch {
    return range;
  }
}

function extractAdvancedOptionsConfig(body: Record<string, unknown>): unknown {
  return body.advancedOptionsConfig ?? null;
}

function extractExtraFields(body: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body)) {
    if (!KNOWN_POLICY_FIELDS.has(key)) {
      extra[key] = value;
    }
  }

  return extra;
}

function getDescription(record: SecurityPolicyRecord): string | undefined {
  if (record.extraFields == null) {
    return undefined;
  }

  const extra = JSON.parse(record.extraFields) as Record<string, unknown>;

  return extra.description as string | undefined;
}

function recordToResponse(
  record: SecurityPolicyRecord,
  description?: string
): SecurityPolicyResponse {
  const rules = JSON.parse(record.rules) as SecurityPolicyRule[];
  const extra =
    record.extraFields != null ? (JSON.parse(record.extraFields) as Record<string, unknown>) : {};

  const desc = description ?? (extra.description as string | undefined);

  delete extra.description;

  const response: SecurityPolicyResponse = {
    kind: record.kind,
    id: extractPolicyId(record),
    creationTimestamp: record.creationTimestamp,
    name: record.name,
    selfLink: record.selfLink,
    fingerprint: record.fingerprint,
    rules: rules as SecurityPolicyRuleResponse[],
    ...extra,
  };

  if (desc != null) {
    response.description = desc;
  }

  if (record.advancedOptionsConfig != null) {
    response.advancedOptionsConfig = JSON.parse(record.advancedOptionsConfig) as unknown;
  }

  return response;
}

function extractPolicyId(record: SecurityPolicyRecord): string {
  return record.id;
}

function operationRecordToResponse(record: GlobalOperationRecord): GlobalOperationResponse {
  return {
    kind: record.kind,
    id: record.operationId,
    name: record.name,
    operationType: record.operationType,
    targetLink: record.targetLink,
    targetId: record.targetId,
    status: record.status,
    selfLink: record.selfLink,
    insertTime: record.insertTime,
    startTime: record.startTime,
    endTime: record.endTime,
  };
}
