---
name: write-for-humans
description: Write code, commits, PRs, ADRs, and tickets so a reader with zero context can follow them. Use when authoring or reviewing code, commit messages, pull requests, design docs, ADRs, or issue-tracker tickets in any repository.
---

# Write for Humans

Clarity is a service to the next reader, who probably doesn't have your context. Every surface — code, name, comment, commit, PR description, ticket, ADR — does the same job: answer "what would the next person who reads this need to know to not break it, or not be confused?"

This skill is repo-agnostic. Where it conflicts with rules, conventions, or knowledge notes in the repository you are working in, **the repository wins** — those reflect the current preferred state.

Decide which surface you are writing, then apply the matching section:

- **Code** (names, methods, comments, logs) → section 1
- **Changes** (commit messages, PR titles and descriptions) → section 2
- **Documents** (tickets, ADRs, specs, proposals) → section 3

---

## 1. Code

### The pseudocode test

An orchestrating method should read as numbered steps. Each line is one step, named for intent — `requireMapping`, `desiredGrants`, `addMissingGrants` — and a reader can restate the method without opening a single helper. The mechanics live one call down.

```java
private DirectoryGroupMapping converge(UUID mappingId) {
    DirectoryGroupMapping mapping = requireMapping(mappingId);
    GroupGrants desired = desiredGrants(mapping);
    GroupGrants actual = readGroupGrants(mapping.groupId());

    removeExtraGrants(mapping.groupId(), desired, actual);
    addMissingGrants(mapping.groupId(), desired, actual);
    return mapping;
}
```

- Extract small helpers whenever doing so makes the caller read as English — even when the helper is called from exactly one place. Extraction serves the reader of the *caller*, not reuse.
- Guards get named predicates too, so the guard is a sentence instead of a boolean expression the reader must decode: `if (isStaleAdd(member, eventAt))`. If a guard would need a comment to explain the condition, the condition belongs inside a named predicate — the name is the comment.
- Long methods need an explicit reason. Acceptable: a declarative pipeline that *is* the operational sequence, or a single algorithm that is genuinely one thought. Not acceptable: tangled flow that could be named steps.

### Naming

- Variable names describe **what the value is for in this context**, not just the type: `arnsOfTransactionsAlreadyPublished`, `possibleError`, `jobTimeout`.
- Method names pick the right verb: `get*` for cheap reads, `find*` for lookups that may miss, `require*` for fetch-or-throw, `ensure*` for idempotent writes, `validate*` for checks that report errors, `is*`/`has*`/`skip*` for predicates.
- Be verbose when verbosity carries meaning; a name that reads as a sentence is correct. No abbreviations beyond domain-standard ones. But if a name is getting long because the method does too many things, fix the *method*.
- Match the naming idioms already in the codebase. Don't invent parallel suffixes.

### Comments

Default state is **no comment**. Comments carry what the code cannot:

1. **External-system surprise** — the code looks weird because reality is weird ("the API sends amounts in the smallest currency unit", with a link to the vendor doc).
2. **Cross-team contracts** — tripwires for contributors outside your team ("discuss with the ledger owners before changing account types").
3. **Why the obvious thing is wrong** — when code looks redundant or inverted, say why it must be that way.
4. **Edge-case fences** — cases the code intentionally doesn't handle, and what to do if one appears.

Never write:

- Comments that restate the next line (`// increment counter`, `// constructor`).
- Section dividers — signatures are self-documenting.
- **Diff comments** (`// fix for when X happens`, `// previously did Y`). That context belongs in the commit body, which survives refactors instead of bit-rotting beside changed code.
- `TODO`/`FIXME`/`HACK` without a tracker ticket reference. A TODO without a ticket is a leak — file the ticket first.

Documentation comments on public types and non-trivial public methods (Javadoc, docstrings, rustdoc — whichever the language uses): first sentence is an imperative summary, then paragraphs for context, cross-references to related types, and sparing `IMPORTANT:` / `NOTE:` / `LIMITATIONS:` callouts for what a skimmer must not miss. On a class that orchestrates a multi-step flow, the class-level doc carries the cross-method invariants: ordering and why, idempotency assumptions, which crash windows converge on retry.

### Logs

Log lines are written for the on-call reader at 3am: state what just happened and, where useful, what the system will do as a consequence ("Ingestion disabled. Unsubscribing."). Use structured placeholders, not concatenation. Choose level deliberately: info for state transitions, warn for recoverable surprises, error for things needing a human. Never log plaintext PII or message payloads — log operations on identifiers.

---

## 2. Changes — commits and pull requests

Write every commit body as if a tired teammate reads it during an incident years from now.

### Subject / title

- Use the repo's convention for type prefixes and ticket tags (Conventional Commits `feat:`/`fix:`/`chore:` is the usual default); never write a bare subject.
- Imperative mood, ≤72 characters. The title carries the "why" on its own — assume it is read cold in five months in `git log` with nothing around it. `fix: Bound consumer concurrency to protect the connection pool` defends something; `fix: Add semaphore` does not.
- If a previous attempt didn't land cleanly, own it in the subject ("(again) due to bad copy/paste"). Don't bury the previous attempt.

### Body / description

- Include a body unless the change is genuinely trivial. Wrap at ~72 chars in commits.
- Answer **why this change exists**, never **what lines moved** — the diff shows the what. Structure causally: empirical observation → trade-off → decision → user-facing rationale.
- Prose, not bullet salad. Bullets only for genuinely enumerable things (affected services, rollout steps).
- For bug fixes that overturn an assumption: state the assumption, the counter-evidence, your speculation flagged *as* speculation, and the recommended fix with a link.
- Keep the evidence that establishes causality, cut the rest. One decisive number beats a paragraph of narrative; investigation dead-ends and chronology are almost never worth a line.
- A PR description is not a transcript of the investigation. Lead with the mental model in plain English before any class name. Three paragraphs or fewer in the "why" section; length tracks the complexity of the *why*, never the size of the change.
- Anything the reader must act on — a mitigation to apply now, a rollback hazard, a follow-up ticket — goes in a single bolded callout (`**NOTE**:`, `**IMPORTANT**:`, `**LIMITATIONS:**`), not buried mid-paragraph.

### Voice

- "It turns out…" is a polite signpost when the system surprised you, not a hedge.
- Avoid "I think", "honestly", "in my opinion". Frame uncertainty as observation about the system.
- Own mistakes briefly, once ("I missed…"), then move on.

---

## 3. Documents — tickets, ADRs, specs, proposals

Context is built brick by brick. Foundations and root problems come first; engineering detail comes last. A link is never a substitute for explaining — if the reader must click three links before your first paragraph makes sense, the document failed.

### The shape

Sections in this order, each building on the last; none reordered. Delete a section only when there is genuinely nothing to put in it.

1. **Why do this.** Plain language, no jargon — what the system does today and why anyone should care. A reader with zero context must get through this section.
2. **The 10,000-foot view.** One diagram or a short numbered description of the whole flow, before any detail lands.
3. **The problems.** Numbered, named subproblems. Each: how the mechanism works today → why it breaks → what it costs. Explain the mechanism *before* critiquing it; name root causes, not symptoms. "See `address.go`" is evidence, not explanation.
4. **Proposed solution.** Tenets first — the principles the design must satisfy — then the new 10,000-foot view.
5. **Anticipated questions.** Headings phrased as the reader's own questions ("What about backfilling?"). Edge cases and rejected alternatives live here.
6. **The numbers.** Every assumption stated, arithmetic shown. A figure is meaningless until the reader sees the inputs.
7. **Rollout plan.** Staged, flag-gated, backwards compatible — or one line saying there's no rollout complexity.
8. **Unanswered questions.** List everything you don't know. A spec that hides its gaps creates surprises in production.
9. **Additional reading.** Links live here at the end, as corroboration — never as the argument itself.

A ticket is the same shape compressed: title states the problem plainly (not the code change); body runs context → problem → proposal → observable acceptance criteria → out of scope. An ADR states the decision, the tenets and constraints that shaped it, the alternatives rejected and why, and the consequences — including the ugly parts, named honestly.

### Prose rules

- Concrete over abstract: real table names, endpoints, dollar figures, dates — never "the data layer" when you can name the table.
- Gloss jargon and acronyms on first use. Every number carries its assumption or source.
- One idea per paragraph. Numbered lists for sequences, tables for matrices.
- Separate evidence from speculation: facts stated plainly, inference flagged ("it's likely that…").
- No throat-clearing, no filler transitions, no ritual empty sections ("Introduction", "Background" that restate the title). Every sentence teaches the reader something or gets deleted.
- No AI-tell vocabulary: seamless, load-bearing, delve, leverage-as-verb, robust, "in today's fast-paced world". Use plain words.
- One fact, one home. Don't repeat the same figure in three sections.
- Acceptance criteria are observable outcomes, not platitudes ("we will test thoroughly" is not a criterion).
- Name the ugly parts honestly. Edge cases named in the doc are handled in design; edge cases hidden become incidents.

---

## Validation checklist

Before submitting, read the artifact once as the coldest reasonable reader:

- [ ] A reader with zero prior context can follow it top to bottom without clicking a link or opening code.
- [ ] Each orchestrating method restates as numbered pseudocode; guards are named predicates.
- [ ] Every comment passes "could a reader derive this from the code alone?" — if yes, it's deleted.
- [ ] No diff-narration comments; rationale lives in the commit body.
- [ ] Every `TODO`/`FIXME`/`HACK` has a ticket reference.
- [ ] No PII or payloads in logs; log lines say action + consequence.
- [ ] Commit subject has its type prefix, ≤72 chars, carries the why.
- [ ] Commit/PR body answers why in prose with decisive evidence; no diff enumeration.
- [ ] Documents run foundations → problems → solution → detail → rollout → open questions; problems are named, mechanism-explained, and costed before any critique.
- [ ] Every number shows its assumption or source; every acronym is glossed on first use.
- [ ] Open questions are listed explicitly; no sentence survives that doesn't teach.
- [ ] No sentence repeats a fact that lives on another surface.

---

## What this skill is *not*

- Not licence for 60-character method names or single-use wrapper types by reflex — verbose names solve a naming problem; if a name is long because the method does too much, fix the method.
- Not a license to introduce abstractions just to unify signatures — new types need genuine domain value.
- Not a style guide that overrides the repo — repository conventions and rules always win.
