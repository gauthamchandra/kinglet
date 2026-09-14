# ADR-016: Cloud Armor Preconfigured WAF and Adaptive Protection Request Headers

## Status

Proposed (addendum to [ADR-012](012-cloud-armor-emulation.md))

Do not edit ADR-012. That record already lets Terraform *write* WAF and
Adaptive Protection rules, then evaluates those CEL functions to `false`.
This addendum is the local testing path for:

- `evaluatePreconfiguredWaf`
- `evaluateAdaptiveProtection`
- `evaluateAdaptiveProtectionAutoDeploy`

## Context

On GCP, Cloud Armor can deny a request because a preconfigured WAF
signature matched, or because Adaptive Protection flagged the traffic.
Kinglet already stores those rules. It does not run OWASP CRS, and it
does not run Adaptive Protection’s model. Until this change, the three
functions above always returned `false` at evaluate time. A policy whose
only deny rule is WAF therefore applied cleanly and then allowed every
request.

There is still no `securityPolicies.evaluate` RPC. Testers need a way to
say “treat this request as a WAF / Adaptive Protection hit” the same way
they already spoof `origin.ip`, ASN, JA3, and SNI with kinglet-only
headers ([ADR-014](014-cloud-armor-asn-region-headers.md)).

Issue #92’s example:

```
X-Kinglet-Waf-Match: protocolattack-v33-stable/owasp-crs-v030301-id921110-protocolattack
X-Kinglet-Adaptive-Protection: true
```

Real Terraform almost never calls `evaluatePreconfiguredWaf('set')` with
no options. Authors pass `opt_out_rule_ids` or `opt_in_rule_ids`. If
kinglet matched on the rule-set name alone, an opted-out signature would
still return 403. That is a fake match, which ADR-012 forbids.

## Decision

The evaluation listener accepts two more request headers, in the same
adapter as `X-Kinglet-Origin-IP`. Those header names appear only in
`listener.ts`. The CEL engine keeps talking in GCP terms (`origin`,
`request`, and the documented builtins). It does not know the kinglet
header names.

| Header | What it means | Missing or empty | Accepted values | Anything else |
|---|---|---|---|---|
| `X-Kinglet-Waf-Match` | “These WAF signatures hit.” Each item is `ruleSet/signatureId`. | No WAF matches | Comma-separated `ruleSet/signatureId` pairs | HTTP 400; kinglet does not evaluate the policy |
| `X-Kinglet-Adaptive-Protection` | “Adaptive Protection flagged this request.” | Treated as `false` | `true` or `false`, any case | HTTP 400; kinglet does not evaluate the policy |

Strip both headers before CEL runs. A rule that checks
`request.headers['x-kinglet-waf-match']` must not see them. HTTP already
joins duplicate headers with commas; the adapter splits on comma.

A WAF value is invalid (400, no evaluate) when:

- a piece has no `/` (rule-set name only — without a signature id,
  `opt_out` cannot be honest)
- a piece has more than one `/` (a sensitivity / paranoia segment we
  cannot honor)
- a piece is empty after trimming

Empty-after-trim on the whole header means “unset,” not garbage.

### How `evaluatePreconfiguredWaf` decides

`evaluatePreconfiguredWaf(set, opts?)` is true only when all of these
hold:

1. The tester injected a pair whose `ruleSet` equals `set`.
2. That signature is allowed by the option map, if one was passed.
3. The option map is a map. A list as the second argument is a miss.
   Kinglet does not implement the older list-shaped second argument on
   this function.

Option map rules:

- `opt_out_rule_ids` — those signature ids do **not** match, even if
  injected.
- `opt_in_rule_ids` — only those ids match, and only when
  `sensitivity` is `0`.
- Passing both `opt_in` and `opt_out` is a miss.
- `opt_in` with a sensitivity other than `0` is a miss.
- `sensitivity` defaults to `4`. Allowed values are integers `0`–`4`.
  Any other value is a miss.
- Kinglet has no catalog of official signature ids and no paranoia
  mapping. An injected id has no sensitivity of its own. If the base
  set is non-empty (`sensitivity >= 1`), the id is treated as in that
  set. Testers cannot distinguish `sensitivity: 1` from `sensitivity: 4`.

Unknown WAF set names still apply at write time. Options are checked
only at evaluate time. A map with nonsense values misses that rule and
evaluation continues to the next one. Extra keys on the map are ignored
(kinglet still cannot prove what production apply does with them).

### How Adaptive Protection decides

`evaluateAdaptiveProtection(alertId)` and
`evaluateAdaptiveProtectionAutoDeploy()` both follow the header boolean.
Kinglet evaluates the CEL arguments so a broken expression still errors,
then ignores their values. The same `true` means “this request was
flagged.” It is not a real alert id and not a heavy-hitter IP. Matching
a specific alert id is out of scope. Values other than `true` / `false`
are 400 so `yes` or a UUID cannot silently miss.

### When the rule runs

WAF expressions still run in the **body** phase, even though the match
comes from a header. That keeps GCP-shaped ordering:

- a WAF `redirect` that matches still becomes `deny(403)`
- an earlier header-phase `allow` still wins over a later WAF deny
- other conditions in the same expression still have to match
  (`origin.ip` and WAF both have to hit)
- GET with an empty body can still match if the WAF header is set

Adaptive Protection-only expressions stay in the **header** phase.

Do not expose `wafMatches` or `adaptiveProtectionMatch` as CEL
identifiers. They live on `RequestAttributes` the same way `sni` already
does. The listener does not copy the matched signature onto the
response. Existing `X-Kinglet-*` response headers stay the Cloud Logging
stand-in.

## Rationale

Testers should exercise the same Terraform they apply on GCP. Shipping a
CRS engine would invent detections we cannot certify against Google’s
sets.

`opt_out` / `opt_in` have to work. Otherwise a local 403 is a lie.

A sensitivity segment on the header would pretend kinglet knows which
signatures belong to paranoia levels 1–4. It does not.

One Adaptive Protection boolean is enough to test AutoDeploy policies.
Two headers would be more faithful to the two CEL functions, but the
issue only needs “this request was flagged.”

A bad header returns 400, same as a bad `X-Kinglet-Origin-IP`. A typo
must not fall through to default allow.

## Alternatives Considered

### Run OWASP CRS / ModSecurity against the request

Closest to GCLB. Rejected: Google’s preconfigured sets are not a drop-in
CRS release. A local 403 from a guessed regex is the fake match ADR-012
forbade.

### Ship a signature catalog (id → sensitivity)

Would make `sensitivity: 1` vs `4` real. Rejected for this change: the
tables go stale, and the issue’s tests declare a specific id.

### Reject unknown sets / bad option maps at write time

Follows the public docs page. Rejected until we have production-apply
evidence (ADR-012 write path is **[Field]**). Filtering at evaluate time
is enough so tests do not 403 an opted-out signature.

### Exact Adaptive Protection alert ids

Rejected until a fixture has two alerts to tell apart. Non-boolean
header values still 400.

### A separate AutoDeploy header

More faithful to the two CEL functions. Rejected: the issue’s use case
is “this request was flagged by Adaptive Protection.” Document the
collapse.

### Echo the matched signature on the response

Rejected: testers already sent the value. ADR-012 left match-field
response headers out of scope.

## Consequences

- `terraform apply` plus curl can exercise preconfigured WAF and
  Adaptive Protection rules. Send the headers. Kinglet does not inspect
  the payload and does not run Adaptive Protection ML.
- A payload that would match on GCP misses here without the header. A
  header match can still miss on GCP. Sensitivity 1 vs 4 cannot be
  distinguished.
- `evaluatePreconfiguredExpr`, organization address groups, threat
  intel, managed rules, and `preconfiguredWafConfig` field exclusions
  stay unimplemented. Project-scoped `evaluateAddressGroup` is
  [ADR-015](015-cloud-armor-evaluate-address-group.md).
- `listPreconfiguredExpressionSets` stays unimplemented.

## References

- [ADR-012](012-cloud-armor-emulation.md)
- [ADR-014](014-cloud-armor-asn-region-headers.md)
- [ADR-015](015-cloud-armor-evaluate-address-group.md)
- Custom rules language — https://cloud.google.com/armor/docs/rules-language-reference
- Preconfigured WAF rules — https://cloud.google.com/armor/docs/waf-rules
- Issue #92 — https://github.com/gauthamchandra/kinglet/issues/92
