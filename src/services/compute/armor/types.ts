/**
 * Cloud Armor evaluation types.
 *
 * Shapes follow compute.securityPolicies and the request view used by the
 * custom rules language. HTTP I/O lives outside this package.
 */

export const DEFAULT_RULE_PRIORITY = 2147483647;

export const MAX_SRC_IP_RANGES = 10;
export const MAX_SUBEXPRESSIONS = 5;
export const MAX_EXPRESSION_CHARS = 2048;
export const MAX_SUBEXPRESSION_CHARS = 1024;
export const MAX_MATCHES_PER_EXPRESSION = 1;
export const MAX_ENFORCE_ON_KEY_CONFIGS = 3;
export const RATE_LIMIT_KEY_VALUE_MAX_BYTES = 128;

export const REQUEST_BODY_INSPECTION_BYTES = {
  '8KB': 8 * 1024,
  '16KB': 16 * 1024,
  '32KB': 32 * 1024,
  '48KB': 48 * 1024,
  '64KB': 64 * 1024,
} as const;

export type RequestBodyInspectionSize = keyof typeof REQUEST_BODY_INSPECTION_BYTES;

export type JsonParsing = 'DISABLED' | 'STANDARD' | 'STANDARD_WITH_GRAPHQL';

export type ArmorStatus = 'INVALID_ARGUMENT' | 'FAILED_PRECONDITION';

export class ArmorError extends Error {
  readonly code: number;
  readonly status: ArmorStatus;

  constructor(message: string, status: ArmorStatus = 'INVALID_ARGUMENT', code = 400) {
    super(message);
    this.name = 'ArmorError';
    this.status = status;
    this.code = code;
  }
}

export interface AdvancedOptionsConfig {
  jsonParsing?: JsonParsing;
  requestBodyInspectionSize?: RequestBodyInspectionSize;
  userIpRequestHeaders?: string[];
}

export interface SrcIpConfig {
  srcIpRanges?: string[];
}

export interface ExprMatch {
  expression?: string;
}

export interface SecurityPolicyMatch {
  versionedExpr?: string;
  config?: SrcIpConfig;
  expr?: ExprMatch;
}

export interface RateLimitThreshold {
  count?: number;
  intervalSec?: number;
}

export interface EnforceOnKeyConfig {
  enforceOnKeyType?: string;
  enforceOnKeyName?: string;
}

export interface RedirectOptions {
  type?: string;
  target?: string;
}

export interface RateLimitOptions {
  rateLimitThreshold?: RateLimitThreshold;
  banThreshold?: RateLimitThreshold;
  banDurationSec?: number;
  conformAction?: string;
  exceedAction?: string;
  enforceOnKey?: string;
  enforceOnKeyName?: string;
  enforceOnKeyConfigs?: EnforceOnKeyConfig[];
  exceedRedirectOptions?: RedirectOptions;
}

export interface RequestHeaderToAdd {
  headerName?: string;
  headerValue?: string;
}

export interface HeaderAction {
  requestHeadersToAdds?: RequestHeaderToAdd[];
}

export interface SecurityPolicyRule {
  priority: number;
  action: string;
  preview?: boolean;
  description?: string;
  match?: SecurityPolicyMatch;
  rateLimitOptions?: RateLimitOptions;
  headerAction?: HeaderAction;
  redirectOptions?: RedirectOptions;
}

export interface SecurityPolicy {
  name?: string;
  rules?: SecurityPolicyRule[];
  advancedOptionsConfig?: AdvancedOptionsConfig;
}

export interface OriginAttributes {
  ip: string;
  userIp: string;
  userIpResolved: boolean;
  regionCode: string;
  asn: number;
  tlsJa3Fingerprint: string;
  tlsJa4Fingerprint: string;
}

export interface HttpRequestAttributes {
  headers: Record<string, string>;
  method: string;
  path: string;
  query: string;
  scheme: string;
  body: string;
  params: Record<string, unknown>;
}

export interface RequestAttributes {
  origin: OriginAttributes;
  request: HttpRequestAttributes;
  sni: string;
}

export interface RequestAttributeInput {
  method: string;
  path: string;
  originIp: string;
  query?: string;
  headers?: Record<string, string | readonly string[] | undefined>;
  body?: string;
  scheme?: string;
  asn?: number;
  regionCode?: string;
  tlsJa3Fingerprint?: string;
  tlsJa4Fingerprint?: string;
  sni?: string;
  userIpRequestHeaders?: readonly string[];
  jsonParsing?: JsonParsing;
  params?: Record<string, unknown>;
}

export interface MatchedRule {
  name?: string;
  priority: number;
  action: string;
  outcome: string;
}

export interface EvaluationResult {
  enforced?: MatchedRule;
  preview?: MatchedRule;
}

export type ExpressionEvaluation = { ok: true; matched: boolean } | { ok: false; error: string };
