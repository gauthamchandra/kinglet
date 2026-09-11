# ADR-015: Cloud Armor Preconfigured WAF and Adaptive Protection Request Headers

## Status

Proposed (addendum to [ADR-012](012-cloud-armor-emulation.md))

ADR-012 is left unchanged. This record only adds the listener path ADR-012
deferred for `evaluatePreconfiguredWaf`, `evaluateAdaptiveProtection`, and
`evaluateAdaptiveProtectionAutoDeploy`.

## Context

ADR-012 accepts those CEL builtins at write time so Terraform WAF / Adaptive
Protection rules apply, and evaluates them to `false`. A WAF-only policy
therefore falls through to default allow. There is no `securityPolicies.evaluate`
RPC, and kinglet cannot run OWASP CRS or Adaptive Protection ML.

The useful local test is the same as ASN / JA3 / SNI in
[ADR-014](014-cloud-armor-asn-region-headers.md): the tester declares the Armor
request view. Issue #92 asks for:

```
X-Kinglet-Waf-Match: protocolattack-v33-stable/owasp-crs-v030301-id921110-protocolattack
X-Kinglet-Adaptive-Protection: true
```

Real Terraform almost never calls a bare `evaluatePreconfiguredWaf('set')`.
It adds `opt_out_rule_ids` / `opt_in_rule_ids`. Matching on rule-set name
alone would 403 an opted-out signature. ADR-012 forbids that fake 403.

## Decision

The listener accepts two more request headers, in the same adapter as
`X-Kinglet-Origin-IP`. Kinglet header names still appear only in
`listener.ts`. The engine stays GCP-shaped.

| Header | Armor effect | Absent / empty | Valid values | Invalid |
|---|---|---|---|---|
| `X-Kinglet-Waf-Match` | Injected `{ ruleSet, signatureId }` list for `evaluatePreconfiguredWaf` | no matches | Comma-separated `ruleSet/signatureId` | 400, no evaluate |
| `X-Kinglet-Adaptive-Protection` | `evaluateAdaptiveProtection` and `evaluateAdaptiveProtectionAutoDeploy` | `false` | `true` / `false` (case-insensitive) | 400, no evaluate |

These headers are stripped before CEL, so
`has(request.headers['x-kinglet-waf-match'])` is false. Duplicate WAF headers
are comma-joined by HTTP; the adapter splits on comma. A rule-set-only value
(`protocolattack-v33-stable` with no `/signatureId`) is invalid: without an id,
`opt_out` cannot be truthful. A third path segment (sensitivity) is invalid.
Empty-after-trim is unset, not garbage.

`evaluatePreconfiguredWaf(set, opts?)` returns true iff an injected match has
the same `ruleSet`, the signature survives `opt_out_rule_ids` /
`opt_in_rule_ids`, and the requested sensitivity is a non-empty base set
(`>= 1`, default 4) or is `0` with the id in `opt_in_rule_ids`. Injected
signatures have no paranoia level. They are in every non-empty base set. There
is no catalog of official signature ids. A list-form second argument is a miss
(the deprecated LIST shape is not implemented on this function).

`evaluateAdaptiveProtection(alertId)` and
`evaluateAdaptiveProtectionAutoDeploy()` both follow the boolean. The CEL
argument is evaluated and then ignored. The same `true` is a declared Adaptive
Protection hit, not a real alert or heavy-hitter IP. Alert-id equality is out
of scope.

WAF calls stay body-phase even though matching is injected. A WAF `redirect`
that matches still becomes `deny(403)`. A header-phase allow still
short-circuits a later WAF deny. Adaptive Protection-only expressions stay
header-phase. GET with an empty body can still match. Injection does not skip
other conjuncts.

Write-time validation is unchanged. Unknown WAF set names still apply. Option
maps are honored at evaluate time only. Nonsense maps miss the rule; evaluation
continues.

Do not put `wafMatches` / `adaptiveProtectionMatch` in the CEL env. They sit
on `RequestAttributes` the way `sni` already does. The listener does not echo
matched signatures on the response. Existing `X-Kinglet-*` response headers
remain the Cloud Logging stand-in.

## Rationale

- Testers need to exercise the same Terraform they apply on GCP. A CRS engine
  would invent detections kinglet cannot certify.
- `opt_out` / `opt_in` must be real or local 403s lie.
- A sensitivity segment on the header would pretend paranoia filtering works
  without Google's mapping.
- Boolean Adaptive Protection is the first rung that unblocks AutoDeploy
  policies. Distinguishing alert ids needs two AP rules we do not have.
- Fail-closed 400 matches Origin-IP / JA3: a typo must not fall through to
  default allow.

## Alternatives Considered

### Run OWASP CRS / ModSecurity against the request

Closest to GCLB. Rejected: Google's preconfigured sets are not a drop-in CRS
release, and a local 403 from a guessed regex is the fake match ADR-012 forbade.

### Ship a signature catalog (id → sensitivity)

Would make `sensitivity: 1` vs `4` real. Rejected for this change: the tables
go stale, and the issue's test suites declare a specific id.

### Write-time reject of unknown sets / bad option maps

Follows the docs page. Rejected until we have production-apply evidence
(ADR-012 write path is **[Field]**). Evaluate-time filtering is enough for
tests not to 403 an opted-out signature.

### Exact Adaptive Protection alert ids

Rejected until a fixture has two alerts to distinguish. Non-boolean header
values 400 so `yes` / a UUID cannot silently miss.

### Separate AutoDeploy header

More faithful to the two CEL functions. Rejected: the issue's use case is
"this request was flagged by Adaptive Protection." Document the collapse.

### Echo the matched signature on the response

Rejected: testers already sent the value. ADR-012 left match-field response
headers out of scope.

## Consequences

- `terraform apply` plus curl can exercise preconfigured WAF and Adaptive
  Protection rules. Send the headers. Kinglet does not inspect the payload
  and does not run Adaptive Protection ML.
- A payload that would match on GCP misses here without the header. A header
  match can still miss on GCP. Sensitivity 1 vs 4 cannot be distinguished.
- `evaluatePreconfiguredExpr`, address groups, threat intel, managed rules,
  and `preconfiguredWafConfig` field exclusions stay unimplemented.
- `listPreconfiguredExpressionSets` stays unimplemented.

## References

- [ADR-012](012-cloud-armor-emulation.md)
- [ADR-014](014-cloud-armor-asn-region-headers.md)
- Custom rules language — https://cloud.google.com/armor/docs/rules-language-reference
- Preconfigured WAF rules — https://cloud.google.com/armor/docs/waf-rules
- Issue #92 — https://github.com/gauthamchandra/kinglet/issues/92
