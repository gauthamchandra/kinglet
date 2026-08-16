# ADR-006: Open-Source Licensing and Governance

## Status

Accepted

## Context

This project was developed privately and is now being published publicly. Three problems had
to be resolved before that could happen, and one had to be designed from scratch.

**The name infringed.** The project was called "LocalStack GCP Emulator" and shipped as
`localstack-gcp`. [LocalStack](https://localstack.cloud) is an unrelated commercial product
and trademark held by LocalStack GmbH, and it occupies the same category — local cloud
emulation for development.

`package.json` compounded this by declaring `"author": "LocalStack Team"`. **That attribution
was simply false.** Every line of this codebase was written internally. LocalStack GmbH, the
LocalStack project, and its maintainers have never contributed to it, reviewed it, endorsed
it, or had any involvement with it whatsoever, and no LocalStack code was copied or derived
from. The field appears to have been an early scaffolding default that was never corrected —
it recorded no real contribution and was removed for that reason as much as for the
trademark one.

**The license was contradictory and unmet.** `LICENSE` and `package.json` declared MPL-2.0
while `README.md` claimed MIT. Separately, MPL-2.0 Exhibit A requires a notice header in every
covered file; none of the 164 files under `src/` carried one, so the project was not compliant
with the license it claimed.

**There was no contributor-facing governance layer at all.** Every convention holding the
codebase together lived in `CLAUDE.md` and `.claude/agents/` — files written for AI coding
agents. Nothing described scope, review expectations, API-fidelity requirements, or what
"done" means for a contribution. A public repository in that state accumulates low-quality
contributions faster than a solo maintainer can decline them, and each decline becomes an
argument rather than a citation.

## Decision

**Rename to `kinglet`.** Verified free on npm (both `kinglet` and `kinglet-gcp`, with zero
packages matching an npm search), crates.io, and Docker Hub. The closest GitHub name match
has been archived since 2017. It carries no existing meaning in the mocking or test-double
space, which is precisely why the candidates that *did* — facade, simulacrum, understudy,
trompe — were rejected.

**Relicense from MPL-2.0 to Apache-2.0.** Verified before switching that `main` contains
commits from a single human copyright holder, so no third-party consent was required.

**Require DCO sign-off, not a CLA.** Sign-off is worded so that it doubles as the
responsibility attestation for AI-assisted contributions.

**Solo maintainer (BDFL), explicitly no support SLA.** Stated plainly in `CONTRIBUTING.md`
rather than left for contributors to infer.

**Publish an eight-layer contribution quality architecture** — scope, API fidelity, tests,
lint, commits, provenance, visibility, and review — where each layer is checkable by CI or by
citing a document, never by argument. See `CONTRIBUTING.md`.

## Rationale

### Why Apache-2.0 over MPL-2.0

MPL-2.0's file-level copyleft protects against unshared modifications to the project's own
files. kinglet ships as a container image that people *run*; almost nobody links against it or
redistributes modified sources. The clause protects against a scenario that will essentially
never occur, while MPL is routinely flagged by corporate open-source review processes — real
adoption friction bought for theoretical protection.

Staying on MPL-2.0 would also have required adding an Exhibit A header to all 164 source
files to become compliant. Apache-2.0 requires none.

### Why Apache-2.0 over MIT

kinglet reimplements a large cloud vendor's API surface. Apache-2.0 §3 grants an express
patent license from every contributor to every user, and terminates it for anyone who brings
a patent suit. MIT grants no patent rights at all and relies on a much weaker implied-license
theory. For a project whose entire purpose is reproducing someone else's API, this is the
single most valuable clause available.

Apache-2.0 is also the license of Google's own client libraries and the Discovery Documents
this project consumes, which removes any compatibility question about derived API-surface
material.

### Why DCO over a CLA

A CLA would let the maintainer relicense or commercialize later. There is no such plan, and a
CLA assigning broad rights to an *individual's personal account* is among the strongest known
deterrents to drive-by contributions.

DCO costs a contributor one `-s` flag and produces the thing actually needed: a per-commit
record that the author had the right to submit the code. It also provides a natural home for
the AI-responsibility attestation — the sign-off is where "I have read and I stand behind
every line" belongs.

### Why the fidelity contract is the highest-leverage rule

The characteristic failure of a generated emulator is an endpoint that looks plausible and is
wrong — a misspelled field, an HTTP 400 where GCP returns 409, a response envelope that no
real client library accepts. Such code passes review by inspection and fails only in a user's
integration test months later.

Requiring every emulated endpoint to cite the official Google Discovery Document converts
that from a judgement call into a lookup. The project already had the machinery
(`discovery-document-registry.json`, `src/core/discovery/`, and a compatibility-audit skill);
this decision makes it a contributor obligation rather than an internal tool.

## Alternatives Considered

### Keep the name, add a disclaimer

A "not affiliated with LocalStack GmbH" notice does not cure use of a confusingly similar mark
in the same product category — it is evidence of awareness. Rejected.

### Publish with no governance documents and add them reactively

Cheapest up front, and the standard way solo-maintained repositories become unmaintained ones.
The first out-of-scope PR arrives before the policy that would have prevented it, and the
maintainer must then invent and defend a rule under pressure from someone who has already
done the work. Rejected.

### Enforce conventions only through local git hooks

The existing husky + commitlint setup is bypassed by `--no-verify` and absent entirely in
forks that skip `bun install`. Any rule that matters must be enforced server-side. Rejected in
favour of moving commitlint into CI.

## Consequences

### Positive

- No trademark exposure from the project name or attribution.
- Corporate users can adopt without a license review escalation.
- Contributors receive an explicit patent grant, and grant one in return.
- Scope disputes resolve by citing a document instead of by argument.
- API fidelity becomes a checkable claim rather than a reviewer's impression.

### Negative

- The rename breaks existing image references. Users of `ghcr.io/gauthamchandra/localstack-gcp`
  must switch to `ghcr.io/gauthamchandra/kinglet`. GitHub's repository redirect covers git
  remotes but not container image paths.
- Historical tags remain inconsistent (`v1.0.0`, `localstack-gcp-v1.1.0`, then `v1.3.0`+).
  Existing tags were left alone; release-please emits `v{version}` going forward.
- ADRs 001–005 refer to the project by its former name. They were deliberately not edited;
  `docs/adrs/README.md` explains this.
- DCO adds one step for first-time contributors who forget `git commit -s`.
- Apache-2.0 permits proprietary forks. This is accepted: the goal is adoption, and the
  copyleft being given up was not protecting anything in practice.

## Implementation Notes

`CHANGELOG.md` retains references to the former name. It is generated by release-please from
commit history and is a factual record of releases that were published under that name;
rewriting it would falsify the record.

Git history retains the former name in commit messages and tags for the same reason.

## References

- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
- [Developer Certificate of Origin](https://developercertificate.org/)
- [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)
- [CONTRIBUTING.md](../../CONTRIBUTING.md)
- [ADR-004: Modular Service Gateway Pattern](004-modular-service-gateway.md)
