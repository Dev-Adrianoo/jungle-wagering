# The entrypoint is in exec form and bun runs as PID 1 so SIGTERM reaches the application
# directly and the graceful shutdown runs; a shell wrapper would swallow the signal.
FROM oven/bun:1.3.12

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
USER bun
EXPOSE 3000

CMD ["bun", "run", "src/main.ts"]
