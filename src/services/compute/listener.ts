/**
 * Cloud Armor local listener — evaluate-only, no origin.
 *
 * This file is the ONLY place kinglet header names appear.
 * The armor engine (armor/) must never reference them.
 */

import type { Server } from 'bun';
import { evaluate } from './armor/evaluate.ts';
import { buildRequestAttributes, isValidIp } from './armor/request.ts';
import type {
  EvaluationResult,
  JsonParsing,
  RequestAttributeInput,
  SecurityPolicy,
} from './armor/types.ts';
import type { SecurityPolicyResponse } from './types.ts';

// ── Kinglet-only header names (only referenced here) ──

const KINGLET_ORIGIN_IP_HEADER = 'x-kinglet-origin-ip';
const KINGLET_SECURITY_POLICY_HEADER = 'x-kinglet-security-policy';
const KINGLET_ENFORCED_PRIORITY_HEADER = 'x-kinglet-enforced-priority';
const KINGLET_ENFORCED_ACTION_HEADER = 'x-kinglet-enforced-action';
const KINGLET_ENFORCED_OUTCOME_HEADER = 'x-kinglet-enforced-outcome';
const KINGLET_PREVIEW_PRIORITY_HEADER = 'x-kinglet-preview-priority';
const KINGLET_PREVIEW_ACTION_HEADER = 'x-kinglet-preview-action';
const KINGLET_PREVIEW_OUTCOME_HEADER = 'x-kinglet-preview-outcome';

// ── Adapter input type ──

export interface ListenerRequestInput {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  tcpPeer: string;
  body: string;
  scheme: string;
  userIpRequestHeaders: readonly string[];
  jsonParsing?: JsonParsing;
}

export type ListenerRequestResult =
  | { attributes: ReturnType<typeof buildRequestAttributes> }
  | { error: string };

// ── Request adapter: kinglet I/O → engine attributes ──

export function buildRequestAttributesFromListenerRequest(
  input: ListenerRequestInput
): ListenerRequestResult {
  const { headers, tcpPeer } = input;

  const rawIp = headers[KINGLET_ORIGIN_IP_HEADER];
  let originIp: string;

  if (rawIp != null) {
    if (!isValidIp(rawIp.trim())) {
      return { error: `Invalid X-Kinglet-Origin-IP value: ${rawIp}` };
    }

    originIp = rawIp.trim();
  } else {
    originIp = tcpPeer;
  }

  const strippedHeaders: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== KINGLET_ORIGIN_IP_HEADER) {
      strippedHeaders[key] = value;
    }
  }

  const existingXff = strippedHeaders['x-forwarded-for'];

  if (existingXff != null) {
    strippedHeaders['x-forwarded-for'] = `${existingXff}, ${originIp}`;
  } else {
    strippedHeaders['x-forwarded-for'] = originIp;
  }

  const requestInput: RequestAttributeInput = {
    method: input.method,
    path: input.path,
    originIp,
    query: input.query,
    headers: strippedHeaders,
    body: input.body,
    scheme: input.scheme,
    userIpRequestHeaders: input.userIpRequestHeaders,
  };

  if (input.jsonParsing != null) {
    requestInput.jsonParsing = input.jsonParsing;
  }

  const attributes = buildRequestAttributes(requestInput);

  return { attributes };
}

// ── Decision → HTTP response ──

export interface ArmorDecision {
  status: number;
  headers: Record<string, string>;
}

export function jsonParsingFromPolicy(policy: SecurityPolicyResponse): JsonParsing | undefined {
  const config = policy.advancedOptionsConfig;

  if (config == null || typeof config !== 'object') {
    return undefined;
  }

  const jsonParsing = (config as { jsonParsing?: unknown }).jsonParsing;

  if (
    jsonParsing === 'DISABLED' ||
    jsonParsing === 'STANDARD' ||
    jsonParsing === 'STANDARD_WITH_GRAPHQL'
  ) {
    return jsonParsing;
  }

  return undefined;
}

export function userIpRequestHeadersFromPolicy(policy: SecurityPolicyResponse): readonly string[] {
  const config = policy.advancedOptionsConfig;

  if (config == null || typeof config !== 'object') {
    return [];
  }

  const headers = (config as { userIpRequestHeaders?: unknown }).userIpRequestHeaders;

  if (!Array.isArray(headers)) {
    return [];
  }

  return headers.filter((header): header is string => typeof header === 'string');
}

export function redirectTargetFromPolicy(
  policy: SecurityPolicyResponse,
  priority: number | undefined
): string | undefined {
  if (priority == null) {
    return undefined;
  }

  const rule = policy.rules.find(candidate => candidate.priority === priority);
  const options = rule?.redirectOptions;

  if (options == null || typeof options !== 'object') {
    return undefined;
  }

  const target = (options as { target?: unknown }).target;

  return typeof target === 'string' && target !== '' ? target : undefined;
}

export function handleArmorDecision(
  result: EvaluationResult,
  policyName: string,
  redirectTarget?: string
): ArmorDecision {
  const enforced = result.enforced;
  const preview = result.preview;

  const action = enforced?.action ?? 'allow';
  const priority = enforced?.priority ?? 2147483647;
  const outcome = enforced?.outcome ?? 'ALLOW';

  const status = actionToStatus(action);

  const headers: Record<string, string> = {
    [KINGLET_SECURITY_POLICY_HEADER]: policyName,
    [KINGLET_ENFORCED_PRIORITY_HEADER]: String(priority),
    [KINGLET_ENFORCED_ACTION_HEADER]: action,
    [KINGLET_ENFORCED_OUTCOME_HEADER]: outcome,
  };

  if ((action === 'redirect' || action.startsWith('redirect(')) && redirectTarget != null) {
    headers.location = redirectTarget;
  }

  if (preview != null) {
    headers[KINGLET_PREVIEW_PRIORITY_HEADER] = String(preview.priority);
    headers[KINGLET_PREVIEW_ACTION_HEADER] = preview.action;
    headers[KINGLET_PREVIEW_OUTCOME_HEADER] = preview.outcome;
  }

  return { status, headers };
}

function actionToStatus(action: string): number {
  if (action === 'allow') {
    return 200;
  }

  if (action === 'redirect' || action.startsWith('redirect(')) {
    return 302;
  }

  const denyMatch = /^deny\((\d+)\)$/.exec(action);

  if (denyMatch != null) {
    return Number.parseInt(denyMatch[1] ?? '403', 10);
  }

  return 403;
}

// ── Policy resolution ──

export type PolicySelectionResult = SecurityPolicyResponse | { error: string };

export function selectPolicy(
  policies: SecurityPolicyResponse[],
  defaultPolicyName: string | undefined
): PolicySelectionResult {
  if (policies.length === 0) {
    return { error: 'No security policies found in project. Cannot evaluate requests.' };
  }

  if (defaultPolicyName != null) {
    const found = policies.find(p => p.name === defaultPolicyName);

    if (found == null) {
      return {
        error: `Configured defaultPolicy '${defaultPolicyName}' not found in project.`,
      };
    }

    return found;
  }

  if (policies.length === 1) {
    const policy = policies[0];

    if (policy == null) {
      return { error: 'No security policies found.' };
    }

    return policy;
  }

  return {
    error:
      `Multiple security policies exist but no defaultPolicy is configured. ` +
      `Set COMPUTE_ARMOR_DEFAULT_POLICY to specify which policy to use.`,
  };
}

// ── Listener server ──

export interface ArmorListenerOptions {
  port: number;
  defaultPolicyName?: string | undefined;
  getPolicies: (project: string) => Promise<SecurityPolicyResponse[]>;
  project: string;
}

export function startArmorListener(options: ArmorListenerOptions): Server {
  const { port, defaultPolicyName, getPolicies, project } = options;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const method = request.method;
      const path = url.pathname;
      const query = url.search.startsWith('?') ? url.search.substring(1) : url.search;

      const headersMap: Record<string, string> = {};

      request.headers.forEach((value, key) => {
        headersMap[key.toLowerCase()] = value;
      });

      const peerInfo = server.requestIP(request);
      const tcpPeer = peerInfo?.address ?? '127.0.0.1';
      const body = await request.text();
      const rawOriginIp = headersMap[KINGLET_ORIGIN_IP_HEADER];

      if (rawOriginIp != null && !isValidIp(rawOriginIp.trim())) {
        return new Response('', { status: 400 });
      }

      const policies = await getPolicies(project);
      const policyOrError = selectPolicy(policies, defaultPolicyName);

      if ('error' in policyOrError) {
        return new Response('', { status: 503 });
      }

      const adapterInput: ListenerRequestInput = {
        method,
        path,
        query,
        headers: headersMap,
        tcpPeer,
        body,
        scheme: 'http',
        userIpRequestHeaders: userIpRequestHeadersFromPolicy(policyOrError),
      };

      const jsonParsing = jsonParsingFromPolicy(policyOrError);

      if (jsonParsing != null) {
        adapterInput.jsonParsing = jsonParsing;
      }

      const adapterResult = buildRequestAttributesFromListenerRequest(adapterInput);

      if ('error' in adapterResult) {
        return new Response('', { status: 400 });
      }

      const policy = policyOrError as SecurityPolicy;
      const result = evaluate(policy, adapterResult.attributes);
      const decision = handleArmorDecision(
        result,
        policyOrError.name,
        redirectTargetFromPolicy(policyOrError, result.enforced?.priority)
      );

      return new Response('', {
        status: decision.status,
        headers: decision.headers,
      });
    },
  });

  return server;
}
