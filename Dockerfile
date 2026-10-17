# Agent Courtroom: one container serves the React UI, the API/SSE/OAuth, the trial engine and the auto-trial watcher.
FROM oven/bun:1.3.11
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# Tailwind is compiled at build time so the server doesn't do it on every boot.
RUN bun run css

ENV NODE_ENV=production
# Cloud Run injects PORT (8080); src/config.ts reads it.
EXPOSE 8080
CMD ["bun", "src/server.ts"]
