# ADR-012: Cloud Armor Security Policy Emulation

## Status

Proposed

## Context

Cloud Armor policies live on Compute Engine (`compute.securityPolicies`,
`/compute/v1/`). Terraform and `@google-cloud/compute` already call that
API. Mutations return `compute#operation`, which clients poll via
`globalOperations.get` / `wait`.

Discovery documents describe resource shapes. They do not fully describe
evaluation, and a few official pages disagree with what `apply` does in
production. Adding a service is usually routine
([docs/adding-a-service.md](../adding-a-service.md)); this one is not,
because the useful part is evaluating requests, not storing JSON.

Three problems to resolve:

1. **Which behavior to implement** when Google’s docs disagree with
   production apply.
2. **Where evaluation runs.** There is no `securityPolicies.evaluate`
   method. A store-only emulator can apply Terraform but cannot tell you
   whether a rule matches.
3. **How to test IP rules locally.** In GCP, `origin.ip` is the load
   balancer’s peer address and cannot be set by the client. Every local
   curl shares one peer, so office-allow / attacker-deny rules cannot be
   exercised without extra network setup — or a kinglet-only way to set
   the peer that does not leak into CEL.

## Decision

### Implement `compute.securityPolicies`, not a Cloud Armor API

The service is `src/services/compute/` on `/compute/v1/`. Phase 1
implements:

- `securityPolicies`: `insert`, `get`, `list`, `delete`, `patch`,
  `addRule`, `removeRule`, `getRule`, `patchRule`
- `globalOperations`: `get`, `wait`

Mutations return `kind: compute#operation` with `status: DONE` and
`targetLink` set to the policy `selfLink`. This is not
`google.longrunning.Operation` and does not share the Workflows
operations store (ADR-009). There is no async work, so the operation is
done before the HTTP response is written.

No `evaluate` method on Compute. No `/compute/v1/…/evaluate`. Other
Compute resources stay unimplemented (404, not a stub 200).

The compatibility registry lists only `securityPolicies` and
`globalOperations`, so coverage is measured against that subset, not all
of Compute Engine. `/compute/v1/` gets the same path-prefix treatment
Storage already has for `/storage/v1/`.

### When docs and apply disagree, follow apply

The **[GCP]** / **[Field]** / **[Practice]** markers in this ADR are
citations on the claims below, not labels we put in source code.
Implementers do not tag files or symbols. The markers only say where
a behavior came from when we had to choose:

| Marker | Meaning |
|---|---|
| **[GCP]** | Official docs or the Compute discovery document. Implement it, or reject with a real GCP error. |
| **[Field]** | Observed production apply or evaluate behavior. Use this when it conflicts with a doc page, and keep the conflict written here. |
| **[Practice]** | Authoring convention (priority bands, embedded vs standalone rules). Mentioned only to say we do not enforce it. |

Known **[Field]** conflicts:

- Expression subexpression limit is **5**. The quotas page currently
  says 10; apply fails with
  `Expression count of N exceeded maximum of 5`.
- At most one `matches()` per expression.
- `x in [a, b]` fails (`undeclared reference to '@in'`). Terraform plan
  does not catch this. Kinglet’s write path must.

### Write a Cloud Armor expression checker, not a generic CEL library

A generic CEL library accepts syntax Armor rejects. Local apply would
succeed and GCP apply would fail.

`matches()` is RE2 search (partial match unless the pattern is anchored).
Do not use JavaScript `RegExp`.

These function calls are accepted so Terraform WAF / Enterprise rules
apply, and they evaluate to `false` until those features exist:

`evaluatePreconfiguredWaf`, `evaluatePreconfiguredExpr`,
`evaluateAddressGroup`, `evaluateOrganizationAddressGroup`,
`evaluateThreatIntelligence`, `evaluateAdaptiveProtection`,
`evaluateAdaptiveProtectionAutoDeploy`.

Do not return 403 from an unimplemented WAF set. That would look like
the signature matched.

### Evaluation engine is GCP-shaped; kinglet I/O sits outside it

```
SecurityPolicy + RequestAttributes → EvaluationResult
```

`RequestAttributes` is the Armor request view (`origin.*`, `request.*`).
`EvaluationResult` is the fields Cloud Logging puts on
`http_load_balancer` (`configuredAction`, `outcome`, `priority`, plus
the preview counterparts).

CEL, priority walk, rate limiting, and Compute handlers never read
kinglet header names. A separate adapter turns an incoming HTTP request
into `RequestAttributes` and turns `EvaluationResult` into the HTTP
status and kinglet response headers.

### Behavior the engine must match

Inlined from official docs and production notes. This is the spec the
engine is tested against. **[Practice]** items (how to number
priorities, whether to use standalone Terraform resources) are omitted
on purpose.

**Ordering [GCP]**

- A policy is an ordered list of rules: priority, match, action.
- Lowest numeric priority is evaluated first. The first matching
  non-preview rule wins. Later rules are not consulted.
- Priority `2147483647` is the default rule. It always exists and cannot
  be deleted; only its action can change.
- `insert` with no rules adds a default `allow` at `2147483647`.
- Two rules cannot share a priority. Priority is the rule id in the API
  and in Terraform import
  (`…/securityPolicies/{policy}/priority/{priority}`).

**Actions [GCP]**

- Backend policy actions: `allow`, `deny(403|404|429|502)`, `redirect`,
  `throttle`, `rate_based_ban`.
- `preview: true` logs the would-be action and evaluation continues.
  Logs record the first matching rule only (preview or enforced).

**Header phase vs body phase [GCP]**

- Header-phase attributes (IP, path, query, headers, method, scheme,
  JA3/JA4, ASN, region, reCAPTCHA tokens) run first, by priority.
- Body-phase attributes (`request.body`, `request.params`,
  `evaluatePreconfiguredWaf` / `evaluatePreconfiguredExpr`) run after
  the body arrives.
- A header-phase `allow` that matches prevents a later body-phase WAF
  `deny` from running. An IP allow above a WAF deny exempts that IP
  from WAF.
- `redirect` and `headerAction` apply in the header phase only. A
  `redirect` that matches in the body phase becomes `deny`.
- Body inspection is truncated to
  `advancedOptionsConfig.requestBodyInspectionSize`
  (`8KB` / `16KB` / `32KB` / `48KB` / `64KB`).

**Request attributes [GCP, Field]**

- `origin.ip` is the load balancer peer. It is not `X-Forwarded-For`.
- `origin.user_ip` comes from
  `advancedOptionsConfig.userIpRequestHeaders`. If that header is
  missing or not a valid IP, it falls back to `origin.ip`.
- `request.path` is the path the client sent, before any URL-map
  rewrite.
- `request.query` is the raw query string (not decoded).
- `request.headers` keys are lowercase. Multi-value headers are
  comma-joined.
- `request.method` is uppercase. `request.scheme` is lowercase.
- Reading a missing map key is an error, not `false`. The rule does not
  match and does not fail the request; evaluation continues. Guard with
  `has(request.headers['x']) && …`.
- `origin.asn`, `origin.region_code`, JA3, and JA4 are empty unless the
  caller can actually supply them. Kinglet does not terminate TLS and
  does not look up ASNs. Do not infer them from `origin.ip`.

**Expressions [GCP, Field]**

| Limit | Value |
|---|---|
| Subexpressions (each comparison or call) | 5. `&&` / `\|\|` / `!` do not count. |
| Characters per subexpression | 1024 |
| Characters per expression | 2048 |
| `matches()` per expression | 1 |
| Rule description | 2048 via API |

Supported operators and functions: `==` `!=` `!` `&&` `||` (precedence
`!` > `&&` > `||`), `contains` / `startsWith` / `endsWith` / `matches`,
`lower` / `upper`, `inIpRange`, `has`, `int`, `size`, `base64Decode`,
`urlDecode`, `urlDecodeUni`, `utf8ToUnicode`.

Rejected at write time: `x in [...]`, regex capture groups (use
`(?:…)`), `request.query_params()` / `request.query.<name>`, CEL
macros.

`versionedExpr = SRC_IPS_V1` with `srcIpRanges` is a basic rule: at
most 10 CIDRs, `*` allowed. An 11th range fails on write.

**Rate limits [GCP, Field]**

- `throttle`: over `rateLimitThreshold` in `intervalSec` →
  `exceedAction` for the rest of the interval; otherwise
  `conformAction` (`allow`).
- `rate_based_ban`: same, then ban the key for `banDurationSec`.
  Optional `banThreshold` is a total-request trigger.
- `intervalSec` / `banThreshold.intervalSec` must be one of
  `10, 30, 60, 120, 180, 240, 300, 600, 900, 1200, 1800, 2700, 3600`.
  `banDurationSec` must be one of
  `60, 120, 180, 240, 300, 600, 900, 1200, 1800, 2700, 3600`.
- `rateLimitThreshold.count`: 1–1,000,000 (`throttle`), 1–10,000
  (`rate_based_ban`).
- Up to 3 `enforceOnKeyConfigs` form one composite key.
  `enforceOnKey` must be empty when configs are set.
- Key types: `ALL`, `IP`, `XFF_IP`, `USER_IP`, `HTTP_HEADER`,
  `HTTP_COOKIE`, `HTTP_PATH`, `SNI`, `REGION_CODE`,
  `TLS_JA3_FINGERPRINT`, `TLS_JA4_FINGERPRINT`.
- Missing `HTTP_HEADER` / `HTTP_COOKIE` degrades that component to
  `ALL`. Unresolvable `USER_IP` degrades to `IP`. Header/cookie values
  truncate at 128 bytes.
- `headerAction` plus `throttle` / `rate_based_ban` makes the rule
  accept everything **[Field]**. Do not “fix” this.
- `throttle` may be patched to `rate_based_ban`. The reverse is
  rejected; delete and recreate.

Kinglet counts exactly, in-process, in one region. GCP is approximate
and per-region. Tests should send requests one at a time.

**Persistence quirks that cause Terraform drift [Field]**

- Store IPv6 compressed (leading zeros dropped).
- Omitting `advancedOptionsConfig` does not clear
  `userIpRequestHeaders`. To clear it, send the block with an empty
  list.
- Persist and return `fingerprint`, `selfLink`, `kind`, `id`,
  `creationTimestamp`. Echo unknown beta fields the provider sends
  (`enforceOnKeyConfigs`, `autoDeployConfig`, …).

**Attachment [GCP, Field]**

- In GCP the URL map picks a backend service, and that service’s
  `securityPolicy` is what runs. No policy on the backend means no
  Armor evaluation.
- The policy must be in the same project as the backend. Cross-project
  references fail on apply.
- Backend-service attachment is out of scope for Phase 1. Until it
  exists, the local listener uses `defaultPolicy`, or the only policy
  in the project. Zero or many policies without `defaultPolicy` is an
  error. Do not pick one silently.

### Local listener: evaluate only — no origin behind it

The listener is a second port on the same kinglet process. It is not
mounted on `/compute/v1/`. It is not a reverse proxy and it does not
forward to an app. Nobody needs to stand up a backend inside kinglet
to test a policy.

Armor decides, then the listener returns a status that reflects that
decision:

| Enforced action | HTTP status | Body |
|---|---|---|
| `deny(403\|404\|429\|502)` | that status | empty |
| `throttle` / `rate_based_ban` over limit | `exceedAction` (usually `deny(429)`) | empty |
| `redirect` (header phase) | 302 (or Armor’s redirect status) | Location from the rule |
| `allow` (including the default rule) | **200** | empty |

200 on allow means “this request would have reached a backend.” It is
not an application response. We do not use 404 for allow: `deny(404)`
is a valid Armor action, and a 404 would mix “blocked as missing”
with “allowed, no origin.” Use `X-Kinglet-Enforced-Action` if the
status alone is not enough (preview, which allow won).

Bind address is `127.0.0.1`. `docker run -p 8787:8787` will not reach
it until a bind override is added.

**Request.** The only kinglet request header is
`X-Kinglet-Origin-IP`. The adapter parses it as the peer, then
removes it so `has(request.headers['x-kinglet-origin-ip'])` is false.
If the header is missing, use the real TCP peer. If the value is not
a valid IP, return 400 and do not evaluate (a bad peer string that
“doesn’t match” would fall through to default allow).

Do not put ASN, region, or JA3 on curl headers in this phase.

Do not treat `X-Forwarded-For` or `True-Client-IP` as `origin.ip`.
After the peer is known, rewrite `X-Forwarded-For` the way GCLB does:
`<client value>, <peer>`, or just `<peer>` if the client sent none.
`XFF_IP` and `origin.user_ip` still use the leftmost / configured
header hop.

There is no JSON evaluate URL. Unit tests may call the attribute
builder directly.

**Response.** Production shows the matching rule in Cloud Logging
(`jsonPayload.enforcedSecurityPolicy` /
`previewSecurityPolicy`). The listener copies that onto response
headers so a local test does not need a log sink:

```
X-Kinglet-Security-Policy: example-policy
X-Kinglet-Enforced-Priority: 1000
X-Kinglet-Enforced-Action: deny(403)
X-Kinglet-Enforced-Outcome: DENY
X-Kinglet-Preview-Priority: 750
X-Kinglet-Preview-Action: deny(403)
X-Kinglet-Preview-Outcome: DENY
```

Preview headers are omitted when no preview rule matched. `allow`
(including the default rule) still sets the enforced headers. These
headers are kinglet-only. Application code that reads them will not
work against GCP.

## How to test a policy

There is no origin server to configure. Apply the policy, then curl
the listener. 403 / 429 / 502 (or `deny(404)`) means Armor blocked
the request. 200 means Armor allowed it. Read the `X-Kinglet-*`
headers to see which rule that was.

Provision with Terraform or the Compute API, same as GCP:

```hcl
provider "google" {
  compute_custom_endpoint = "${var.kinglet_endpoint}/compute/v1/"
}

resource "google_compute_security_policy" "example" {
  name = "example-policy"

  rule {
    action   = "deny(403)"
    priority = 1000
    match {
      expr {
        expression = "request.path.startsWith('/admin')"
      }
    }
  }

  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config { src_ip_ranges = ["*"] }
    }
  }
}
```

Always declare the default rule if you care about its action. The API
inserts `allow` at `2147483647` when it is omitted.

**Direct client (browser → GCLB, no CDN).** Rules on `origin.ip` /
`SRC_IPS_V1` / `inIpRange(origin.ip, …)` are the right ones. Set the
peer with `X-Kinglet-Origin-IP`. Send `Host` if any rule reads it;
default `Host` is `127.0.0.1:8787` and `request.scheme` is `http`.

```bash
# Expect 403 from the path rule
curl -s -D - -o /dev/null \
  -H 'Host: app.example.com' \
  -H 'X-Kinglet-Origin-IP: 203.0.113.10' \
  http://127.0.0.1:8787/admin

# Expect 200 — path misses the /admin deny, so the default allow wins
curl -s -D - -o /dev/null \
  -H 'Host: app.example.com' \
  -H 'X-Kinglet-Origin-IP: 198.51.100.10' \
  http://127.0.0.1:8787/public
```

Check `X-Kinglet-Enforced-Priority` / `Action` on the response. That
replaces the Logs Explorer filter
`jsonPayload.enforcedSecurityPolicy.priority=…`.

**Client behind a proxy or CDN.** `origin.ip` is the proxy egress, not
the user. Set `X-Kinglet-Origin-IP` to that egress. Send the
forwarded-client header the proxy would send (`X-Forwarded-For` or
`True-Client-IP`). Configure `userIpRequestHeaders` on the policy and
write user-IP rules on `origin.user_ip` (or `HTTP_HEADER` /
`USER_IP` keys). Do not rewrite `SRC_IPS_V1` rules onto
`origin.user_ip` just to make tests pass: that drops the “peer is a
known proxy” check Armor expects.

**Rate limits.** Send requests sequentially. Reusing the same test IP
across cases shares `IP` buckets; reset or use distinct IPs.

## Rationale

- Compute is what Terraform already calls. A kinglet-only evaluate
  RPC would not exist in production.
- Following apply (5 subexpressions, no `in`) means a policy that
  writes here will write on GCP.
- Unimplemented WAF functions returning `false` is visible and safe.
  A fake 403 is not.
- Matching `headerAction`+throttle and unguarded header errors avoids
  a local “fix” that does not exist in GCP.
- Setting the peer in an adapter, then stripping the kinglet header,
  lets IP rules be tested without a VPN and without CEL seeing a
  kinglet attribute.
- Rewriting `X-Forwarded-For` like GCLB is required for `XFF_IP` and
  header-match rules to see the same string they see in production.
- Response headers stand in for Cloud Logging. No log sink required.
- Binding `127.0.0.1` keeps the listener off other interfaces. Docker
  publish is a later config knob.

## Alternatives Considered

### `src/services/armor/` with `securityPolicies.evaluate`

Smaller module. Rejected: the real API is Compute. CONTRIBUTING.md
does not allow invented methods on the emulated surface.

### Control plane only (no engine)

Smaller first PR. Rejected: Terraform apply without evaluation does
not answer whether a rule matches.

### Generic CEL library

Less parser work. Rejected: it accepts a superset of Armor.

### Use `X-Forwarded-For` as `origin.ip`

No kinglet header. Rejected: `origin.ip` is the peer. XFF is a
request header, an `XFF_IP` key, and optionally `user_ip`.

### Ask authors to rewrite IP rules onto `origin.user_ip`

Uses a real GCP feature. Rejected: `SRC_IPS_V1` cannot follow, and
the rewrite removes the peer check.

### Spoof IP via query string

Rejected: `request.query` is one raw string. Removing a parameter
changes every query rule.

### PROXY protocol

Closest to replacing the TCP peer. Rejected for Phase 1: needs a TCP
front in front of `Bun.serve`, and ordinary curl cannot speak PROXY
on the same port.

### Infer ASN / region from the spoofed IP

Rejected: invented geo. Empty means empty. Curl headers for ASN /
region / JA3 are deferred.

### JSON evaluate endpoint

Easier to set Host / scheme / body. Rejected: the caller would no
longer be sending a normal HTTP request. Unit tests can call the
builder in-process. The listener is the only HTTP entry.

### Proxy allowed requests to a backend inside kinglet

Would make 200 look like a real app response. Rejected for this
phase: attachment and URL maps are out of scope, and testers should
not have to run an origin to check a deny rule. Allow is 200 empty.

## Consequences

- Kinglet owns `/compute/v1/`. Further Compute resources go in this
  module and the registry resource filter.
- `terraform apply` plus curl on `:8787` is enough to test path, IP,
  header, and rate-limit rules. No origin process is required. Allow
  is 200 empty; block is the Armor deny/exceed status.
- A WAF-only policy applies and never matches until preconfigured
  sets are implemented.
- Local rate limits are exact. Concurrent bursts that flake on GCP
  will pass here.
- `request.scheme` is `http`. JA3/JA4/ASN/region are empty on curl.
  Rules that assume HTTPS or a real JA3 will not behave as in GCP.
- Application code must not depend on `X-Kinglet-*` headers.

### Out of scope

Proxying allow to an origin. Backend services and URL maps. Regional, edge, and org policies.
Preconfigured WAF sets, address groups, Adaptive Protection,
reCAPTCHA. `aggregatedList`, `setLabels`,
`listPreconfiguredExpressionSets`. TLS termination. Curl injection
of ASN / region / JA3. JSON evaluate URL. Verbose match-field
response headers. Binding the listener on `0.0.0.0`.

## References

- Security policy overview — https://cloud.google.com/armor/docs/security-policy-overview
- Custom rules language — https://cloud.google.com/armor/docs/rules-language-reference
- Rate limiting — https://cloud.google.com/armor/docs/rate-limiting-overview
- Quotas and limits — https://cloud.google.com/armor/quotas
- Compute `securityPolicies` — https://cloud.google.com/compute/docs/reference/rest/v1/securityPolicies
- [ADR-007](007-memorystore-valkey-data-plane.md), [ADR-008](008-kms-crypto-emulation.md), [ADR-009](009-shared-route-namespace.md)
