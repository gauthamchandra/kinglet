# ADR-005: AI Code Review Bot with Mixture-of-Prompts

## Status

Accepted

## Context

As the project grows, we need automated code review that catches security issues,
enforces architectural decisions (ADRs 001–004), and provides actionable feedback
on pull requests. Manual review alone doesn't scale, and common mistakes (wrong
imports, ADR violations, missing null checks) are tedious to catch repeatedly.

The broader ecosystem offers enterprise solutions like Cursor's BugBot and
CodeRabbit, but with a small maintainer team and modest codebase complexity, we
want to first understand what we actually need before committing to a paid tool.

## Decision

We will implement an automated code review bot using a **Mixture-of-Prompts
(MoP)** architecture, inspired by the
[iCodeReviewer paper (ASE 2025)](https://arxiv.org/abs/2510.12186), running as a
GitHub Actions workflow.

### Key components

- **Model**: DeepSeek-R1-0528 hosted on
  [GitHub Models](https://github.com/marketplace/models/azureml-deepseek/DeepSeek-R1-0528).
  A reasoning model that naturally verifies whether issues are real before
  reporting them, reducing false positives.
- **Router**: An LLM-based classifier that analyzes the PR diff to determine
  which prompt experts to activate. Uses low token budget (256 max) with
  structured JSON output.
- **Prompt experts**: Five specialized review prompts, each focused on a specific
  concern (security, Bun compliance, architecture, test quality, general). Only
  activated experts make LLM calls, running in parallel as separate GitHub Actions
  jobs. All experts output structured JSON findings with deterministic IDs for
  deduplication.
- **Aggregation**: A shell script merges findings from all experts, deduplicates
  by finding ID (`file:line:category`), and keeps the highest severity when
  duplicates exist.
- **Meta-review**: A final LLM pass that receives the aggregated findings plus
  the original diff. It filters false positives, checks cross-expert consistency,
  detects gaps the specialized experts missed, and generates an executive summary
  with risk assessment.
- **ADR context**: Not manually embedded in prompts. The model can browse the
  repository via MCP toolsets (`repos`) to read ADR files when it needs
  architectural context.

### Pipeline

```
route → [security, bun-compliance, architecture, test-quality, general] (parallel)
     → aggregate (jq dedup by finding ID)
     → meta-review (final sweep + executive summary)
     → post-review (render markdown + post PR comment)
```

### Prompt experts

| Expert | Severity Range | Focus |
|--------|---------------|-------|
| Security | 0.7–1.0 | SQL injection, XSS, auth bypass, resource leaks |
| Bun compliance | 0.4–0.7 | ADR-001/002 violations, Node.js API usage, jest patterns |
| Architecture | 0.4–0.7 | ADR-003/004 violations, StorageProvider bypass, gateway patterns, incomplete migrations |
| Test quality | 0.2–0.5 | Assertion quality, mock patterns, test anti-patterns, missing e2e coverage |
| General | 0.0–0.4 | Error handling, race conditions, dead code, style (two-pass internal review) |
| Meta-review | any | False positive filtering, cross-expert consistency, gap detection, executive summary |

### Finding format

All experts output structured JSON. Each finding has a deterministic ID for
deduplication across experts:

```json
{
  "findings": [
    {
      "id": "src/services/pubsub/publisher.ts:42:security",
      "file": "src/services/pubsub/publisher.ts",
      "line": 42,
      "severity": 0.95,
      "category": "security",
      "emoji": "🔴",
      "title": "SQL injection in subscriber lookup",
      "description": "User input directly interpolated into bun:sqlite query",
      "suggestion": "Use parameterized query with ? placeholder"
    }
  ]
}
```

### Prompt quality features

Each expert prompt includes:

- **Severity calibration examples**: Reference scores for common issues to ensure
  consistent scoring across experts (e.g., SQL injection = 0.95, exposed secret
  = 1.0)
- **False positive avoidance rules**: Explicit "Do NOT Flag" sections listing
  concrete patterns that should not be reported (e.g., parameterized queries,
  test file fixtures, internal-only code)
- **Detection examples**: Codebase-specific code snippets showing vulnerable vs
  safe patterns (e.g., bun:sqlite template literal injection)
- **General expert two-pass structure**: The general expert performs two explicit
  internal passes — surface scan then self-challenge — to reduce noise

## Rationale

### Why Mixture-of-Prompts over a single monolithic prompt

The iCodeReviewer paper demonstrates that specialized prompt experts with routing
achieve an 84% acceptance rate in production, significantly outperforming single-
prompt approaches. The key insight is that activating only relevant experts
prevents hallucination — the LLM is not asked about issue categories that cannot
exist in the code being reviewed.

### Why a meta-review pass

Parallel experts have no cross-expert context. The meta-review job acts as a
final quality gate — challenging each finding against the actual codebase (via
repo browsing), filtering false positives, detecting compounded risks when
multiple experts flag the same file, and catching gaps the specialized experts
missed. It also generates the executive summary that appears at the top of the
PR comment.

### Why structured JSON findings with deduplication

Multiple experts may flag the same issue (e.g., a resource leak flagged by both
security and general experts). Structured JSON with deterministic IDs
(`file:line:category`) enables clean deduplication with `jq`, keeping the
highest-severity entry. This also enables the meta-review to programmatically
reason about findings rather than parsing free-form markdown.

### Why DeepSeek-R1-0528

- **Reasoning model**: Chain-of-thought verification naturally filters false
  positives — the model "thinks through" whether an issue is real before reporting
- **Available on GitHub Models**: Data stays within GitHub's ecosystem, no third-
  party API calls, billing through GitHub
- **No external secrets**: Authentication via `GITHUB_TOKEN`, which is
  automatically provided by GitHub Actions
- **Cost-effective**: Open-source model on GitHub's hosted infrastructure

### Why this is a homebrew experiment

This is deliberately a low-cost, homebrew solution to see how close we can get to
enterprise-grade code review using open-source models and GitHub-native tooling.
With a small maintainer team and modest codebase complexity, the overhead of an
enterprise solution (BugBot, CodeRabbit, etc.) isn't justified yet.

As the project grows — more maintainers, more complex service interactions, higher
PR volume — we expect to eventually switch to an enterprise solution once the
cost-benefit tips in their favor. This homebrew approach gives us hands-on
understanding of what we actually need from a review bot before committing to a
paid tool.

## Alternatives Considered

### Single monolithic prompt

**Pros**: Simpler workflow, single LLM call.
**Cons**: Higher false positive rate from hallucination, the LLM tries to find
issues in every category regardless of relevance. Harder to maintain as review
rules grow.

### PR-Agent (Qodo) with third-party APIs

**Pros**: Mature tooling, handles diff parsing and GitHub API integration.
**Cons**: Sends PR diffs to third-party API endpoints (DeepSeek, Mistral).
Less control over prompt structure, can't implement MoP architecture.

### Enterprise solutions (BugBot, CodeRabbit)

**Pros**: Production-grade, actively maintained, rich feature sets.
**Cons**: Cost not justified at current team/codebase scale. Less understanding
of what we actually need. Vendor lock-in before we know our requirements.

### Full iCodeReviewer with tree-sitter AST parsing

**Pros**: More precise routing via symbol tables and taint analysis.
**Cons**: Significantly more complex to implement and maintain. Grep-based
routing is sufficient for our codebase size and service count.

## Consequences

### Positive

- Automated enforcement of ADRs 001–004 on every PR
- Security scanning with low false-positive rate (MoP + reasoning model + meta-review)
- Parallel expert execution — only relevant experts run
- Structured JSON findings with deduplication prevent duplicate noise
- Meta-review pass filters false positives and generates executive summary
- Modular prompt maintenance — each expert can be updated independently
- Near-zero cost (GitHub Models pricing, `GITHUB_TOKEN` auth)
- Hands-on understanding of our actual review needs

### Negative

- More workflow complexity than a single-prompt approach (9 jobs vs 1)
- GitHub Models availability and pricing may change
- Reasoning model (R1) is slower than non-reasoning models
- Meta-review adds one sequential LLM call to the pipeline
- Maintenance burden for prompt experts falls on the team
- LLM-based routing may occasionally misclassify (fail-open by default)

## Implementation Notes

- Workflow: `.github/workflows/ai-review.yml`
- Router prompt: `.github/prompts/router.prompt.yml`
- Router parser: `.github/scripts/parse-router-output.sh`
- Expert prompts: `.github/prompts/{security,bun-compliance,architecture,test-quality,general}-expert.prompt.yml`
- Meta-review prompt: `.github/prompts/meta-review-expert.prompt.yml`
- Aggregation script: `.github/scripts/aggregate-findings.sh`
- Render script: `.github/scripts/render-findings.sh`
- Triggers on `pull_request` events (opened, reopened, ready_for_review)
- Does not block CI — runs as a separate workflow from `ci.yml`

## References

- [iCodeReviewer: Improving Secure Code Review with Mixture of Prompts (ASE 2025)](https://arxiv.org/abs/2510.12186)
- [DeepSeek-R1-0528 on GitHub Models](https://github.com/marketplace/models/azureml-deepseek/DeepSeek-R1-0528)
- [actions/ai-inference](https://github.com/actions/ai-inference)
- [ADR-001: Bun Runtime Choice](001-bun-runtime-choice.md)
- [ADR-002: Pure Bun Testing Framework](002-pure-bun-testing.md)
- [ADR-003: Hybrid Storage Architecture](003-hybrid-storage-architecture.md)
- [ADR-004: Modular Service Gateway Pattern](004-modular-service-gateway.md)
