/**
 * Compute service types: SecurityPolicy and GlobalOperation storage records,
 * table schemas, and name builders.
 *
 * Armor evaluation types live in src/services/compute/armor/types.ts.
 */

import type { BaseRecord, TableSchema } from '@/core/storage/types.ts';

// ── Constants ──

export const SECURITY_POLICIES_TABLE = 'compute_security_policies';
export const GLOBAL_OPERATIONS_TABLE = 'compute_global_operations';

export const COMPUTE_KIND_SECURITY_POLICY = 'compute#securityPolicy';
export const COMPUTE_KIND_OPERATION = 'compute#operation';
export const COMPUTE_KIND_SECURITY_POLICY_LIST = 'compute#securityPolicyList';

// ── Storage Records ──

export interface SecurityPolicyRecord extends BaseRecord {
  name: string;
  project: string;
  selfLink: string;
  fingerprint: string;
  kind: string;
  creationTimestamp: string;
  rules: string;
  advancedOptionsConfig: string | null;
  extraFields: string | null;
}

export interface GlobalOperationRecord extends BaseRecord {
  operationId: string;
  project: string;
  name: string;
  status: string;
  operationType: string;
  targetLink: string;
  targetId: string;
  kind: string;
  selfLink: string;
  insertTime: string;
  startTime: string;
  endTime: string;
}

// ── Table Schemas ──

export const securityPoliciesTableSchema: TableSchema = {
  name: SECURITY_POLICIES_TABLE,
  columns: [
    { name: 'name', type: 'string', unique: true },
    { name: 'project', type: 'string' },
    { name: 'selfLink', type: 'string' },
    { name: 'fingerprint', type: 'string' },
    { name: 'kind', type: 'string' },
    { name: 'creationTimestamp', type: 'string' },
    { name: 'rules', type: 'json' },
    { name: 'advancedOptionsConfig', type: 'json', nullable: true },
    { name: 'extraFields', type: 'json', nullable: true },
  ],
  indexes: [
    { name: 'idx_compute_security_policies_name', columns: ['name'], unique: true },
    { name: 'idx_compute_security_policies_project', columns: ['project'] },
  ],
  timestamps: true,
};

export const globalOperationsTableSchema: TableSchema = {
  name: GLOBAL_OPERATIONS_TABLE,
  columns: [
    { name: 'operationId', type: 'string', unique: true },
    { name: 'project', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'status', type: 'string' },
    { name: 'operationType', type: 'string' },
    { name: 'targetLink', type: 'string' },
    { name: 'targetId', type: 'string' },
    { name: 'kind', type: 'string' },
    { name: 'selfLink', type: 'string' },
    { name: 'insertTime', type: 'string' },
    { name: 'startTime', type: 'string' },
    { name: 'endTime', type: 'string' },
  ],
  indexes: [
    { name: 'idx_compute_global_operations_operationId', columns: ['operationId'], unique: true },
    { name: 'idx_compute_global_operations_project', columns: ['project'] },
  ],
  timestamps: true,
};

// ── Name Builders ──

export function buildSecurityPolicySelfLink(project: string, policyName: string): string {
  return `https://www.googleapis.com/compute/v1/projects/${project}/global/securityPolicies/${policyName}`;
}

export function buildOperationName(project: string, operationId: string): string {
  return `projects/${project}/global/operations/${operationId}`;
}

export function buildOperationSelfLink(project: string, operationId: string): string {
  return `https://www.googleapis.com/compute/v1/projects/${project}/global/operations/${operationId}`;
}

// ── Response Types ──

export interface SecurityPolicyRuleResponse {
  priority: number;
  action: string;
  preview?: boolean;
  description?: string;
  match?: unknown;
  rateLimitOptions?: unknown;
  headerAction?: unknown;
  redirectOptions?: unknown;
  [key: string]: unknown;
}

export interface SecurityPolicyResponse {
  kind: string;
  id: string;
  creationTimestamp: string;
  name: string;
  selfLink: string;
  fingerprint: string;
  rules: SecurityPolicyRuleResponse[];
  advancedOptionsConfig?: unknown;
  [key: string]: unknown;
}

export interface GlobalOperationResponse {
  kind: string;
  id: string;
  name: string;
  operationType: string;
  targetLink: string;
  targetId: string;
  status: string;
  selfLink: string;
  insertTime: string;
  startTime: string;
  endTime: string;
}
