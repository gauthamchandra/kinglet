<!--
Thanks for contributing to kinglet.

Before you fill this in, please skim CONTRIBUTING.md — especially "What we accept".
It is short, and it is the difference between a merged PR and a closed one.
-->

## What does this change?

<!-- One or two sentences. What behaviour is different after this PR? -->

## Why?

<!--
The "why", not the "what" — the diff already shows what changed.

For a fidelity fix, state what real GCP does, what kinglet did instead, and how you
established the difference.
-->

Closes #

---

## API fidelity

<!--
Required if this PR adds or changes an emulated endpoint. Delete this whole section if
the change is docs-only or purely internal.
-->

**Discovery document:** <!-- e.g. https://cloudkms.googleapis.com/$discovery/rest?version=v1 -->

- [ ] Request/response **field names** match the discovery document exactly, including casing
- [ ] **HTTP status codes** match real GCP — including error cases
- [ ] **Error envelope** is `{ error: { code, message, status, details? } }` with real GCP status strings
- [ ] **Resource name format** matches (`projects/{p}/locations/{l}/…`)
- [ ] **Pagination** (`pageSize` / `pageToken` / `nextPageToken`) implemented where GCP paginates
- [ ] Verified against an official `@google-cloud/*` client library

**Not implemented / known gaps:**

<!--
List endpoints, fields, or behaviours this PR deliberately does NOT cover. Partial support is
fine and often correct. Silently partial support is not.
-->

---

## Testing

- [ ] Tests added or updated, co-located as `*.test.ts`
- [ ] `bun test` passes
- [ ] `bun run lint` is clean — **zero errors and zero warnings**
- [ ] Coverage not lowered
- [ ] Error paths tested, not just happy paths
- [ ] No conditional assertions, no `expect(true).toBe(false)` sentinels, every test has a meaningful `expect()`

**How did you verify this manually?**

<!-- Commands run, client library exercised, curl output — whatever you actually did. -->

---

## Contribution declarations

- [ ] **All commits are signed off** (`git commit -s`). By signing off I certify the [DCO](https://developercertificate.org/) — I have the right to submit this under Apache-2.0 — **and that I have read and stand behind every line of it.**

- [ ] **AI disclosure.** Tick this box if an AI tool wrote or substantially shaped any part of this change (implementation, tests, or this description).

<!--
Disclosing AI assistance will never count against your PR. Failing to disclose it will.

The bar is not "was a model involved" — it's "can you explain why this code does what it
does". If a reviewer asks and the honest answer is "the model wrote it", the PR will be
closed. Please make sure you can answer.
-->

- [ ] I did **not** add new `ignoreIssues` entries to `knip.json` (or I explained why below)

---

## Anything else?

<!-- Open questions, ambiguity in the real GCP behaviour you couldn't resolve, follow-up work. -->
