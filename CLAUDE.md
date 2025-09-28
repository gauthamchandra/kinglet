# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

## LocalStack GCP Emulator

A high-performance local emulation environment for Google Cloud Platform services, built with Bun and TypeScript. This project provides local development and testing capabilities for GCP services including Pub/Sub, Cloud Scheduler, Cloud Tasks, and Secret Manager.

## Commands

### Development
- `bun run dev` - Start development server with watch mode
- `bun run start` - Run the production server
- `bun run build` - Build for production
- `bun run healthcheck` - Run health check script

### Testing
- `bun test` - Run all tests
- `bun test --watch` - Run tests in watch mode
- `bun test --coverage` - Run tests with coverage report

### Code Quality
- `bun run lint` - Run ESLint
- `bun run lint:fix` - Run ESLint with auto-fix
- `bun run format` - Format code with Prettier

## Architecture

The codebase follows a modular service-oriented architecture:

### Core Structure
- `src/index.ts` - Main application entry point with graceful shutdown handling
- `src/core/` - Core framework components (gateway, discovery, storage)
- `src/services/` - GCP service emulations (pubsub, scheduler, tasks, secrets)
- `src/config/` - Configuration management with Zod schema validation
- `src/shared/` - Shared utilities, types, and middleware

### Service Emulations
- **Pub/Sub** (`src/services/pubsub/`) - Message queuing and streaming
- **Cloud Scheduler** (`src/services/scheduler/`) - Cron job scheduling
- **Cloud Tasks** (`src/services/tasks/`) - Asynchronous task execution
- **Secret Manager** (`src/services/secrets/`) - Secret storage and management

### Path Aliases
Use TypeScript path aliases for clean imports:
- `@/*` - src root
- `@/core/*` - core framework components
- `@/services/*` - service implementations
- `@/shared/*` - shared utilities
- `@/config` - configuration module

## Bun Runtime

This project uses Bun as the primary runtime (see docs/adrs/001-bun-runtime-choice.md). Key preferences:

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install`
- Use `bun run <script>` instead of `npm run <script>`
- Bun automatically loads .env files

### Bun APIs
- `Bun.serve()` for HTTP servers (don't use Express)
- `bun:sqlite` for SQLite (don't use better-sqlite3)
- `WebSocket` is built-in (don't use ws)
- `Bun.file` for file operations (prefer over node:fs)

### TypeScript Types
When using TypeScript with Bun runtime, avoid Node.js-specific types:
- Use `number` for timers (not `NodeJS.Timeout`)
- Use standard Web API types (not Node.js equivalents)
- Use `Bun.*` types for Bun-specific APIs
- Prefer global JavaScript types over `NodeJS.*` namespace types

## Testing

Uses Bun's built-in test runner with setup in `tests/setup.ts`:

```ts
import { test, expect } from "bun:test";

test("example test", () => {
  expect(1).toBe(1);
});
```

Test environment is configured to use error-level logging and test NODE_ENV.
- When implmenting a task, be sure to first read through the ADRs that exist in docs/adrs so you understand the historical decisions that have been made.
- Use `unknown` instead of `any` type in TypeScript
- Avoid non-null assertions (`!`) - prefer clear type definitions or optional chaining (`?`)
- Co-locate tests with source files for easier discovery
- Try to use `bunx` over `npx` wherever possible
- When moving code to a new location in response to feedback from the user, do not leave useless comments such as "// BEGIN is now called explicitly via begin() method".