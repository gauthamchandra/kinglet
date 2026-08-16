---
description: "Audit GCP API compatibility by comparing our service implementations against official Google REST discovery documents. Use when: /compatibility-audit [service-name], audit compatibility, check GCP coverage, API gap analysis, find missing endpoints, compare with GCP API."
---

# GCP Compatibility Audit

Audit emulated GCP services against their official REST discovery documents to identify missing endpoints, parameter gaps, and schema mismatches.

Accepts an optional service name argument to audit a single service (e.g., `/compatibility-audit cloud-storage`). Without an argument, audits all services.

## Instructions

### Step 1: Read the registry and apply filter

Read `discovery-document-registry.json` from the project root. It contains an array of services, each with:
- `name`: kebab-case service identifier (used for report filenames)
- `displayName`: human-readable name
- `discoveryUrl`: URL to the official GCP REST discovery document
- `version`: API version (e.g., "v2")
- `implementationPath`: relative path to our service implementation

**Service filter**: Check if the user provided a service name argument (the text after `/compatibility-audit`).
- If a service name **was provided**: filter the services array to only include entries where `name` matches the argument. If no match is found, inform the user and list all available service names from the registry, then stop.
- If **no argument** was provided: use the full services array (audit all services).

### Step 2: Dispatch audit subagents

Launch one subagent per service in the filtered list **in parallel** (all in a single message) using the Agent tool with `subagent_type: "general-purpose"`. Each subagent gets the prompt below, with service-specific values filled in.

**Subagent prompt template** (fill in `{SERVICE_NAME}`, `{DISPLAY_NAME}`, `{DISCOVERY_URL}`, `{VERSION}`, `{IMPL_PATH}`):

```
You are auditing the "{DISPLAY_NAME}" ({VERSION}) implementation in kinglet, a local emulator for Google Cloud Platform services.

## Your Task
Compare our implementation against the official GCP REST discovery document and write a compatibility report.

## Step 1: Fetch the Discovery Document
Use WebFetch to fetch: {DISCOVERY_URL}
Ask it to extract and return:
- All methods found by recursively walking the `resources` object tree. Each resource can contain `methods` (a map of method objects) and nested `resources`.
- For each method: its `id`, `httpMethod`, `path`, `parameters` (with required flag and location), `request.$ref`, `response.$ref`
- All top-level `schemas` keys and their properties

## Step 2: Read Our Implementation
Use Glob to find all *.ts files in {IMPL_PATH} (excluding *.test.ts files).
Read each file. Focus on:
- **Route definitions**: Look for `getRoutes()` methods returning `RouteDefinition[]` arrays. Each route has `{ id, method, path, handler }`.
- **Type definitions**: Look for interfaces, types, and Zod schemas that define request/response shapes.
- **Handler implementations**: Note which query parameters and body fields each handler actually reads from requests.

## Step 3: Compare and Analyze

### Endpoint matching
Normalize paths for comparison:
- Discovery doc paths use `{paramName}` placeholders (e.g., `v2/{name=projects/*/locations/*/queues/*}`)
- Our routes use `:paramName` placeholders (e.g., `/v2/projects/:project/locations/:location/queues/:queueId`)
- Match by: same HTTP method AND same logical resource path (ignore parameter naming differences, focus on path structure)
- Custom verbs in discovery docs appear as suffix like `:pause`, `:resume`, `:run`, `:purge` — our routes also use this pattern

### Classification
For each discovery document method, classify as:
- **Implemented**: A matching route exists with the correct HTTP method
- **Missing**: No matching route found
- **IAM (Deferred)**: Methods named `getIamPolicy`, `setIamPolicy`, or `testIamPermissions` — flag separately as intentionally not implemented

### Parameter analysis (for implemented endpoints only)
Compare parameters listed in the discovery doc method against what the handler actually reads from `req.query`, `req.params`, and `req.body`. Note any parameters from the discovery doc that our handler ignores.

### Schema analysis (for implemented endpoints only)
For each request/response schema referenced by implemented methods:
- Find the schema definition in the discovery document's `schemas` section
- Compare its properties against our TypeScript type definitions
- Note any properties present in the discovery doc schema but absent from our types

## Step 4: Write the Report

Write the report to `.compatibility-reports/{SERVICE_NAME}-report.md` using this exact format:

```markdown
# {DISPLAY_NAME} ({VERSION}) Compatibility Report

**Generated**: [current date]
**Discovery Document**: {DISCOVERY_URL}
**Implementation Path**: {IMPL_PATH}

## Summary

- **Implementation Status**: [FULLY IMPLEMENTED | STUB | PARTIAL]
- **Total API Methods**: [count from discovery doc]
- **Implemented**: [count] ([percentage]%)
- **Missing (non-IAM)**: [count]
- **IAM (intentionally deferred)**: [count]

## Endpoint Coverage

| # | Discovery Method ID | HTTP | Path | Status |
|---|---|---|---|---|
| 1 | ... | GET | ... | Implemented |
| 2 | ... | POST | ... | Missing |
| 3 | ... | POST | ... | IAM (Deferred) |

## Missing Endpoints (Non-IAM)

For each missing non-IAM endpoint:

### `method.id`
- **HTTP**: METHOD path
- **Description**: [from discovery doc]
- **Request Schema**: [schema name or "none"]
- **Response Schema**: [schema name or "none"]
- **Parameters**: [list required and optional params]
- **Implementation Notes**: [brief suggestion on what would be needed]

## IAM Endpoints (Intentionally Deferred)

List each IAM method ID on a single line.

## Parameter Gaps

For each implemented endpoint that has parameter gaps:

### `method.id`
| Parameter | Type | Location | Required | Status |
|---|---|---|---|---|
| pageSize | integer | query | No | Handled |
| filter | string | query | No | **Missing** |

## Schema Gaps

For each schema with gaps:

### `SchemaName`
| Property | Type | In Discovery Doc | In Our Types |
|---|---|---|---|
| name | string | Yes | Yes |
| retryConfig | object | Yes | **Missing** |

## Recommendations

Prioritized list of changes to reach 100% compatibility:
1. [Highest priority items first]
2. ...
```

IMPORTANT: If the service is a stub (only a placeholder class with no routes), still fetch and analyze the full discovery document. Report 0% coverage and list ALL methods as missing — this serves as an implementation roadmap.

Return a brief summary of your findings when done (e.g., "Cloud Tasks: 13/19 endpoints implemented (68%), 3 IAM deferred, 3 missing").
```

### Step 3: Generate summary report

**If only a single service was audited** (service name filter was used): skip SUMMARY.md generation. Instead, read the individual report from `.compatibility-reports/{SERVICE_NAME}-report.md` and present the key findings (summary stats + missing endpoints list) directly to the user.

**If multiple services were audited** (no filter): after ALL subagents complete, read each report from `.compatibility-reports/` and write a summary to `.compatibility-reports/SUMMARY.md`:

```markdown
# GCP Compatibility Audit Summary

**Generated**: [current date]

## Coverage Overview

| Service | Version | Status | Implemented | Total | Coverage | IAM Deferred |
|---|---|---|---|---|---|---|
| Cloud Tasks | v2 | ... | ... | ... | ...% | ... |
| Cloud Scheduler | v1 | ... | ... | ... | ...% | ... |
| Secret Manager | v1 | ... | ... | ... | ...% | ... |
| Pub/Sub | v1 | ... | ... | ... | ...% | ... |

## Priority Actions

List the top 5-10 most impactful gaps across all services, prioritized by:
1. Missing core CRUD endpoints on implemented services
2. Missing parameters on implemented endpoints
3. Schema gaps on implemented endpoints
4. Entirely unimplemented services (roadmap)
```

Present the summary table to the user when complete.
