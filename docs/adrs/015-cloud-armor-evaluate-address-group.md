# ADR-015: Cloud Armor `evaluateAddressGroup`

## Status

Proposed (addendum to [ADR-012](012-cloud-armor-emulation.md))

ADR-012 is left unchanged. That record listed `evaluateAddressGroup` among
the CEL functions that apply and evaluate to `false` until the backing
data exists. This record is the later decision to resolve that function
against project-scoped Network Security address groups.

## Context

Cloud Armor’s custom rules language includes
`evaluateAddressGroup(group, ip [, exclusions])`. Real GCP looks up the
named address group on Network Security in the security policy’s
project (`locations/global`) and matches the request IP against the
group’s CIDR items. An optional third argument excludes CIDRs: a group
hit that is also in that list is not a match.

ADR-012 accepted the call so Terraform WAF / Enterprise rules apply, and
stubbed evaluation to `false`. After kinglet gained the Network Security
control plane for project-scoped address groups, the stub was the
remaining gap: policies that name a group would apply and never fire.

The CEL engine in ADR-012 is synchronous and must not perform I/O.
Address-group items live in a different service’s table. Those
constraints still hold.

## Decision

`evaluateAddressGroup` matches against project-scoped Network Security
address groups in the same `StorageManager` as Compute.

- Resolve the group as
  `projects/{policyProject}/locations/global/addressGroups/{name}`.
  The first argument may be the short id or that full resource name.
- The second argument is evaluated like other CEL. A value that is
  already an IP is used as-is; otherwise it is a request header name
  (`origin.ip` / `origin.user_ip` already become IP strings).
- The optional third argument is an exclusion list: a CEL list of CIDR
  strings, or a comma-separated string. A group hit that is also
  excluded is not a match.
- A missing group, Network Security disabled (empty table), or an IP
  outside the items is not a match. It is not a rule error.
- Do not filter on `purpose`. Lookup is by name in the policy’s project.
- `evaluateOrganizationAddressGroup` stays always-false. There is no
  organization collection.

The CEL engine does not read storage. The evaluation server loads
groups for the policy’s project **once per request**, and **only when**
the selected policy has a rule that calls `evaluateAddressGroup`, then
passes a synchronous lookup into `evaluate()`.

Compute may initialize the address-group table so `SERVICES=compute`
alone still serves. The table is empty until Network Security is
enabled and a group is created. Compute does not auto-enable Network
Security.

## Rationale

- The function is defined by Armor docs, not a kinglet convenience API.
  Groups already persist on the Network Security resource name.
- Shared `StorageManager` avoids a kinglet-only seed endpoint and
  avoids the CEL engine taking a Network Security HTTP dependency.
- A miss that looks like “no match” matches GCP’s “unknown group /
  empty lookup” better than a 403 from an unimplemented builtin
  (ADR-012: do not return 403 from an unimplemented WAF set).
- Loading only for policies that call the function keeps path/IP/default
  rules off the address-group table. A long-lived snapshot cache would
  be another layer with invalidation; a per-request load is enough for
  local traffic.

## Alternatives Considered

### Amend ADR-012 in place

Rejected: ADRs are written once. An addendum records the new decision
without rewriting the reasoning that was true when Phase 1 shipped.

### Kinglet-only seed / evaluate API

Rejected: GCP has no such RPC. Clients already create groups on
Network Security and name them from Armor CEL.

### Long-lived in-memory snapshot of groups

Rejected: extra invalidation for a local emulator. Load per evaluating
request instead.

### Load groups on every Armor request

Rejected: unrelated policies would scan the table on every curl. Skip
the load unless the selected policy uses `evaluateAddressGroup`.

### Filter lookup by `CLOUD_ARMOR` purpose

Rejected: match by name in the policy’s project. Purpose is a write-time
Network Security field, not part of the CEL call.

### Evaluate from the Network Security HTTP API at request time

Rejected: the engine stays sync and GCP-shaped (ADR-012). The listener
adapter is the I/O boundary.

## Consequences

- `SERVICES=compute,networksecurity` plus a group in the policy’s
  project is enough for `evaluateAddressGroup` to fire. `SERVICES=compute`
  alone still accepts the call; it is false until a group exists.
- Organization groups, `addItems` / `removeItems` / `cloneItems` /
  `listReferences`, and a purpose filter remain out of scope.
- Google’s docs show some unquoted CIDR lists that are not valid CEL.
  Quoted string lists and comma-separated strings are what kinglet
  evaluates.
- Preconfigured WAF, threat intel, and Adaptive Protection stay
  always-false, as ADR-012 recorded.

## References

- [ADR-012](012-cloud-armor-emulation.md)
- Custom rules language — https://cloud.google.com/armor/docs/rules-language-reference
- Address groups for Cloud Armor — https://cloud.google.com/armor/docs/address-groups-using
- [Testing Cloud Armor policies](../getting-started/cloud-armor.md)
