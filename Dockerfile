FROM oven/bun:1.3.4-slim AS base

# --- Install stage: install production deps only ---
FROM base AS install
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# --- Final stage: copy deps + source, run with Bun ---
FROM base
WORKDIR /app

# org.opencontainers.image.source is what links the GHCR package to this repo and
# lets GHCR inherit the repository's README and visibility settings.
LABEL org.opencontainers.image.title="kinglet" \
      org.opencontainers.image.description="A local emulator for Google Cloud Platform services" \
      org.opencontainers.image.source="https://github.com/gauthamchandra/kinglet" \
      org.opencontainers.image.url="https://github.com/gauthamchandra/kinglet" \
      org.opencontainers.image.licenses="Apache-2.0"

COPY --from=install /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json LICENSE ./
COPY src/ ./src/

# Default ports: 8765 (HTTP), 8766 (gRPC)
EXPOSE 8765 8766

# Create data directory for SQLite persistence
RUN mkdir -p /app/data

# Healthcheck using the existing healthcheck script
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun run src/healthcheck.ts

# Run directly from source — Bun handles TypeScript natively
CMD ["bun", "run", "src/index.ts"]
