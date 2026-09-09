# ADR-014: Cloud Armor ASN, Region, TLS Fingerprint, and SNI Request Headers

## Status

Proposed (addendum to [ADR-012](012-cloud-armor-emulation.md))

ADR-012 is left unchanged. This record only adds the request-header path
ADR-012 deferred for `origin.asn`, `origin.region_code`,
`origin.tls_ja3_fingerprint` / `origin.tls_ja4_fingerprint`, and the
rate-limit `SNI` key.

## Context

Cloud Armor CEL already accepts `origin.asn` (integer),
`origin.region_code` (ISO 3166-1 alpha-2 string), and the TLS fingerprint
strings `origin.tls_ja3_fingerprint` / `origin.tls_ja4_fingerprint`. The
listener in ADR-012 never populates them. They stay `0` / `''` unless a
unit test passes them into the attribute builder.

ADR-012 rejected inferring geo from the spoofed peer and deferred curl
headers for ASN, region, and JA3. Kinglet does not terminate TLS, so it
cannot observe a real JA3/JA4 or TLS SNI. Without a kinglet-only way to
set these attributes, geo and fingerprint rules apply and never match,
and `enforceOnKey: SNI` buckets collapse to `ALL`.

## Decision

The listener accepts additional request headers, in the same adapter that
already handles `X-Kinglet-Origin-IP`. Kinglet header names still appear
only in `listener.ts`. The engine stays GCP-shaped.

| Header | Armor field | Absent | Valid values | Invalid |
|---|---|---|---|---|
| `X-Kinglet-Origin-ASN` | `origin.asn` | `0` | Integer `0`–`4294967295` (empty string is `0`) | 400, no evaluate |
| `X-Kinglet-Origin-Region-Code` | `origin.region_code` | `''` | Empty, or two letters (canonicalized to uppercase) | 400, no evaluate |
| `X-Kinglet-Origin-JA3` | `origin.tls_ja3_fingerprint` | `''` | Empty, or 32 hex characters (canonicalized to lowercase) | 400, no evaluate |
| `X-Kinglet-Origin-JA4` | `origin.tls_ja4_fingerprint` | `''` | Empty, or a JA4 fingerprint (`t13d1516h2_…_…`) | 400, no evaluate |
| `X-Kinglet-Origin-SNI` | rate-limit key `SNI` (not a CEL attribute) | `''` | Empty, or a DNS hostname (lowercase; one trailing FQDN dot stripped) | 400, no evaluate |

These headers are stripped before CEL, so
`has(request.headers['x-kinglet-origin-sni'])` is false. Overrides are
per-field. `Host` is `request.headers['host']` and is never copied into
SNI.

GCP has no `origin.sni` CEL field. Do not invent one. SNI is only
`enforceOnKey: SNI` / `enforceOnKeyConfigs`. Empty SNI degrades that
component to `ALL`, matching the existing engine.

This does **not** look up ASN or country from `origin.ip`. That is a
known fidelity gap versus GCP; see [Deferred work](#deferred-work).
Kinglet still does not terminate TLS; JA3/JA4/SNI come only from these
headers. The listener does not echo resolved match fields on the
response. Existing `X-Kinglet-*` response headers remain the Cloud
Logging stand-in (`enforcedSecurityPolicy` / `previewSecurityPolicy`).

## Rationale

- CEL and `RequestAttributeInput` already have the fields. The gap is
  listener I/O, not the engine.
- Headers match `X-Kinglet-Origin-IP`: testers set the Armor request view
  without a VPN and without CEL seeing a kinglet attribute.
- TEST-NET peers will not resolve in any public IP-to-ASN feed. Overrides
  are what make geo rules testable.
- `0` and `''` must be valid so a later optional lookup can still be
  forced to “unresolved.”
- Uppercasing `us` → `US` matches how authors write
  `origin.region_code == 'US'`.
- JA3/JA4/SNI validation fails closed (400) so a typo does not silently
  miss and fall through to default allow. Empty remains valid so a
  later real TLS path can still be forced to “unresolved.”
- SNI stays off `Host`. GCLB’s SNI is the TLS handshake name; `Host` is
  a request header and a different CEL attribute. RFC 6066 forbids a
  trailing dot on the wire; one FQDN trailing dot is stripped so pasted
  `cdn.example.com.` keys as `SNI:cdn.example.com`.

## Deferred work

In GCP, `origin.asn` and `origin.region_code` are resolved from the
client IP (the load-balancer peer). Kinglet currently leaves them at
`0` / `''` unless the request headers above are set. A policy that
matches here because the tester sent `X-Kinglet-Origin-ASN: 15169` can
still miss on GCP, and a public peer that would match on GCP will not
match here without those headers.

When lookup becomes necessary, the intended shape is:

- A weekly CI job downloads IPToASN TSVs
  (`https://iptoasn.com/`, PDDL) and a Bun script converts them to a
  read-only SQLite file (IPv4 integer ranges, later IPv6).
- The Docker image bakes that file (not under `/app/data`, so a volume
  mount cannot hide it).
- At boot, if Compute is enabled, open a **second** `bun:sqlite`
  `Database` (read-only). Do not `ATTACH` it to `StorageManager` /
  `emulator.db`. Memory mode must still see the file.
- The listener adapter looks up `origin.ip` only (not `origin.user_ip`)
  and fills `RequestAttributeInput.asn` / `regionCode`. The request
  headers in this ADR remain overrides and still 400 on garbage.
- Document that IPToASN is not Google’s intel. Resolution will diverge.

Do not do that in this change. TEST-NET peers used in docs and tests
are unannounced and would still need the headers. Fetching TSV during
`docker build` also makes images non-reproducible and splits `bun run`
from Docker until both have a file.

## Alternatives Considered

### Infer ASN / region from `origin.ip` in this change

Closest to GCLB, and the right long-term fidelity. Deferred — see
above — rather than rejected. Headers stay so TEST-NET tests and
explicit overrides keep working once lookup exists.

### Amend ADR-012 in place

Rejected: ADRs are written once. An addendum records the new decision
without rewriting the reasoning that was true when Phase 1 shipped.

### Echo ASN / region on the response

Rejected: testers already sent the values. ADR-012 left match-field
response headers out of scope.

### Inject via query string

Rejected in ADR-012 for `origin.ip`; the same objection applies.

## Consequences

- `terraform apply` plus curl can exercise `origin.asn`,
  `origin.region_code`, TLS fingerprint rules, and `enforceOnKey: SNI`
  throttles. Send the headers. TEST-NET peers still need the geo
  headers. Fingerprints and SNI are never observed from the wire
  (`request.scheme` stays `http`).
- A policy that matches here because the tester sent
  `X-Kinglet-Origin-ASN: 15169` or a synthetic JA3/SNI can still miss on
  GCP. Kinglet does not yet resolve ASN or country from the peer
  (deferred above) and does not terminate TLS.
- Filling `origin.region_code`, a JA3/JA4, or SNI splits `REGION_CODE` /
  `TLS_JA3_FINGERPRINT` / `TLS_JA4_FINGERPRINT` / `SNI` rate-limit
  buckets. Unset JA3/JA4/SNI degrade to `ALL`; unset region still shares
  `REGION_CODE:`.
- Match-field response headers remain out of scope. There is no
  `origin.sni` CEL attribute.

## References

- [ADR-012](012-cloud-armor-emulation.md)
- Custom rules language — https://cloud.google.com/armor/docs/rules-language-reference
- [Testing Cloud Armor policies](../getting-started/cloud-armor.md)
