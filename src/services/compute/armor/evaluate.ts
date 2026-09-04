/**
 * Cloud Armor policy evaluation: priority walk, header vs body phase,
 * preview, and rate-limit actions.
 */

import { evaluateExpression, expressionUsesBodyPhase, matchSrcIpRanges } from './expression.ts';
import { applyRateLimit } from './rate-limit.ts';
import { withInspectedBody } from './request.ts';
import type {
  EvaluationResult,
  MatchedRule,
  RequestAttributes,
  SecurityPolicy,
  SecurityPolicyRule,
} from './types.ts';
import { REQUEST_BODY_INSPECTION_BYTES } from './types.ts';

export function evaluate(policy: SecurityPolicy, attributes: RequestAttributes): EvaluationResult {
  const rules = [...(policy.rules ?? [])].sort((a, b) => a.priority - b.priority);
  const policyName = policy.name ?? '';
  let preview: MatchedRule | undefined;
  let current = attributes;
  let bodyInspected = false;

  for (const rule of rules) {
    const bodyPhase = isBodyPhaseRule(rule);

    if (bodyPhase && !bodyInspected) {
      current = withInspectedBody(
        attributes,
        inspectionLimitBytes(policy),
        policy.advancedOptionsConfig?.jsonParsing
      );
      bodyInspected = true;
    }

    if (!ruleMatches(rule, current)) {
      continue;
    }

    const phase = bodyPhase ? 'body' : 'header';
    const action = resolveAction(rule, current, policyName, phase, rule.preview === true);
    const record = toMatchedRule(rule, action, policyName);

    if (rule.preview === true) {
      if (preview == null) {
        preview = record;
      }

      continue;
    }

    return finish(record, preview);
  }

  return finish(undefined, preview);
}

function finish(
  enforced: MatchedRule | undefined,
  preview: MatchedRule | undefined
): EvaluationResult {
  const result: EvaluationResult = {};

  if (enforced != null) {
    result.enforced = enforced;
  }

  if (preview != null) {
    result.preview = preview;
  }

  return result;
}

function ruleMatches(rule: SecurityPolicyRule, attributes: RequestAttributes): boolean {
  const versioned = rule.match?.versionedExpr;

  if (versioned === 'SRC_IPS_V1') {
    return matchSrcIpRanges(attributes.origin.ip, rule.match?.config?.srcIpRanges ?? []);
  }

  const expression = rule.match?.expr?.expression;

  if (!expression) {
    return false;
  }

  const result = evaluateExpression(expression, attributes);

  if (!result.ok) {
    return false;
  }

  return result.matched;
}

function resolveAction(
  rule: SecurityPolicyRule,
  attributes: RequestAttributes,
  policyName: string,
  phase: 'header' | 'body',
  preview: boolean
): string {
  let action = rule.action;

  if (action === 'throttle' || action === 'rate_based_ban') {
    if (rule.headerAction != null) {
      action = 'allow';
    } else if (rule.rateLimitOptions != null) {
      action = applyRateLimit(
        policyName,
        rule.priority,
        action,
        rule.rateLimitOptions,
        attributes,
        preview ? 'preview' : 'commit'
      );
    }
  }

  if (phase === 'body' && isRedirectAction(action)) {
    // redirect (and headerAction) apply in the header phase only. A redirect
    // that matches while inspecting the body is treated as deny(403).
    return 'deny(403)';
  }

  return action;
}

function isRedirectAction(action: string): boolean {
  return action === 'redirect' || action.startsWith('redirect(');
}

function toMatchedRule(rule: SecurityPolicyRule, action: string, policyName: string): MatchedRule {
  const matched: MatchedRule = {
    priority: rule.priority,
    action,
    outcome: outcomeOf(action),
  };

  if (policyName !== '') {
    matched.name = policyName;
  }

  return matched;
}

function outcomeOf(action: string): string {
  if (action === 'allow') {
    return 'ALLOW';
  }

  if (action === 'redirect' || action.startsWith('redirect(')) {
    return 'REDIRECT';
  }

  return 'DENY';
}

function isBodyPhaseRule(rule: SecurityPolicyRule): boolean {
  const expression = rule.match?.expr?.expression;

  if (!expression) {
    return false;
  }

  return expressionUsesBodyPhase(expression);
}

function inspectionLimitBytes(policy: SecurityPolicy): number {
  const sizeKey = policy.advancedOptionsConfig?.requestBodyInspectionSize ?? '8KB';

  return REQUEST_BODY_INSPECTION_BYTES[sizeKey] ?? REQUEST_BODY_INSPECTION_BYTES['8KB'];
}
