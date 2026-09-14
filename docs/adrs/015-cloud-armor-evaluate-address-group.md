# ADR-015: Cloud Armor `evaluateAddressGroup`

## Status

Proposed (addendum to [ADR-012](012-cloud-armor-emulation.md))

Do not edit ADR-012. That record listed `evaluateAddressGroup` with the
CEL functions that Terraform can write, then always evaluate to `false`.
This addendum is the later decision: look the group up in Network
Security and match the request IP against its CIDRs.

## Context

Cloud Armor’s custom rules language includes

`evaluateAddressGroup(group, ip [, exclusions])`.

On GCP that call loads a Network Security address group in the security
policy’s project (`locations/global`) and asks whether the request IP is
in the group. An optional third argument is a list of CIDRs to skip: if
the IP is in the group *and* in that exclusion list, it is not a match.

Kinglet accepted the call so Terraform WAF / Enterprise policies apply,
then stubbed it to `false`. After the Network Security control plane
could store project-scoped groups, that stub was the gap. Policies that
named a group applied and never fired.

Two constraints from ADR-012 still apply:

1. The CEL engine is synchronous. It must not do I/O while evaluating a
   rule.
2. Address-group items live in another service’s table, not on the
   security policy.

## Decision

`evaluateAddressGroup` matches against project-scoped Network Security
address groups that share Compute’s `StorageManager`.

- Look up
  `projects/{policyProject}/locations/global/addressGroups/{name}`.
  The first argument may be the short id (`my-group`) or that full
  resource name.
- The second argument is ordinary CEL. If the value is already an IP,
  use it. Otherwise treat it as a request header name
  (`origin.ip` / `origin.user_ip` are already IP strings by the time
  CEL sees them).
- The optional third argument is an exclusion list: a CEL list of CIDR
  strings, or one comma-separated string. A group hit that is also in
  this list is not a match.
- A missing group, Network Security turned off (empty table), or an IP
  that is not in the group is simply not a match. It is not a rule
  error and must not 403 by itself.
- Do not filter on the group’s `purpose` field. Lookup is by name in
  the policy’s project.
- `evaluateOrganizationAddressGroup` stays always-false. Kinglet has
  no organization collection.

The CEL engine never reads storage. Before evaluation, the listener
loads groups for the policy’s project **once per request**, and **only
when** the selected policy has a rule that calls `evaluateAddressGroup`.
It then hands a synchronous lookup into `evaluate()`.

Compute may create the address-group table so `SERVICES=compute` alone
still serves. That table stays empty until Network Security is enabled
and someone creates a group. Compute does not turn Network Security on
by itself.

## Rationale

This function is defined by Armor docs, not a kinglet convenience API.
Groups already live under the Network Security resource name.

Sharing `StorageManager` avoids a kinglet-only seed endpoint, and it
avoids giving the CEL engine an HTTP dependency on Network Security.

A miss that means “no match” is closer to GCP’s “unknown group / empty
lookup” than returning 403 from an unimplemented builtin. ADR-012
already forbade that fake 403 for unimplemented WAF sets.

Loading only when the selected policy calls the function keeps ordinary
path / IP / default rules off the address-group table. A long-lived
snapshot cache would need invalidation. A per-request load is enough
for local traffic.

## Alternatives Considered

### Amend ADR-012 in place

Rejected: ADRs are written once. An addendum records the new decision
without rewriting the reasoning that was true when Phase 1 shipped.

### A kinglet-only seed or evaluate API

Rejected: GCP has no such RPC. Clients already create groups on Network
Security and name them from Armor CEL.

### A long-lived in-memory snapshot of groups

Rejected: extra invalidation for a local emulator. Load once per
evaluating request instead.

### Load groups on every Armor request

Rejected: policies that never mention address groups would still scan
the table on every curl. Skip the load unless the selected policy uses
`evaluateAddressGroup`.

### Filter lookup by `CLOUD_ARMOR` purpose

Rejected: match by name in the policy’s project. Purpose is a
write-time Network Security field, not part of the CEL call.

### Call the Network Security HTTP API during evaluation

Rejected: the engine stays sync and GCP-shaped (ADR-012). The listener
is the I/O boundary.

## Consequences

- `SERVICES=compute,networksecurity` plus a group in the policy’s
  project is enough for `evaluateAddressGroup` to fire.
  `SERVICES=compute` alone still accepts the call; it stays false until
  a group exists.
- Organization groups, `addItems` / `removeItems` / `cloneItems` /
  `listReferences`, and a purpose filter remain out of scope.
- Google’s docs show some unquoted CIDR lists that are not valid CEL.
  Kinglet evaluates quoted string lists and comma-separated strings.
- When this record shipped, preconfigured WAF, threat intel, and
  Adaptive Protection were still always-false, as ADR-012 recorded.
  WAF and Adaptive Protection injection is [ADR-016](016-cloud-armor-waf-adaptive-headers.md).

## References

- [ADR-012](012-cloud-armor-emulation.md)
- Custom rules language — https://cloud.google.com/armor/docs/rules-language-reference
- Address groups for Cloud Armor — https://cloud.google.com/armor/docs/address-groups-using
- [Testing Cloud Armor policies](../getting-started/cloud-armor.md)
