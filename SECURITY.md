# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, pull requests, or
discussions.**

Report privately through GitHub's Private Vulnerability Reporting:

**[→ Report a vulnerability](https://github.com/gauthamchandra/kinglet/security/advisories/new)**

You can also reach this from the repository's **Security** tab → **Report a vulnerability**.
This creates a private advisory visible only to you and the maintainer.

Please include: what the issue is, how to reproduce it, which version or commit you tested,
and what an attacker could achieve.

### What to expect

kinglet has a single maintainer and no response-time commitment — see
[CONTRIBUTING.md](CONTRIBUTING.md#support-expectations). Reports are taken seriously, but a
reply may take a while. If a report is confirmed and fixed, you will be credited in the
advisory unless you'd rather not be.

## Supported versions

Only the latest released version receives fixes. There are no long-term support branches.

## Threat model — please read before reporting

**kinglet is a development and testing tool. It is not intended to be exposed to a network,
and it is not a security boundary.**

By design, and *not* considered vulnerabilities:

- **Authentication is disabled by default** (`auth.enabled: false`, `mode: "bypass"`). kinglet
  accepts unauthenticated requests. That is the point — it exists so you don't need real
  credentials locally.
- **Credentials are mock values.** The default project ID and service account are fixed,
  well-known placeholders. They grant nothing.
- **Data is unencrypted.** Records are stored in plain SQLite or in memory. Emulated secrets
  are not real secrets and should never hold real ones.
- **No rate limiting, quotas, or tenant isolation.** Real GCP has these; kinglet does not
  emulate them as enforcement mechanisms.
- **Deliberately permissive emulated behaviour** where real GCP would reject a request, when
  that permissiveness is documented as a known fidelity gap.

Reports along the lines of "the emulator accepts requests without credentials" will be closed
with a pointer to this section.

### What *is* in scope

- Remote code execution, or any path from a request to arbitrary code or command execution
- Path traversal or arbitrary file read/write outside the configured data directory
- SQL injection reachable through the storage layer
- A crash reachable by an unauthenticated request that a normal client could trigger
  (denial of service against a developer's own machine still wastes their day)
- Dependency vulnerabilities that are actually reachable from kinglet's code
- Anything that could compromise the machine running kinglet, or leak data from outside its
  own storage

**If you found something that lets a local emulator harm the host it runs on, that is in
scope and worth reporting — even though kinglet is "just" a dev tool.**

## Never put real secrets in kinglet

The Secret Manager emulation stores values in plaintext. Use fake values. If you have loaded a
real credential into a local kinglet instance, rotate it.
