FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile

# Build
COPY tsconfig.json ./
COPY packages/core/ packages/core/
COPY packages/server/ packages/server/
COPY packages/web/ packages/web/
COPY packages/cli/ packages/cli/
COPY workflows/ workflows/
RUN pnpm build

# Production image
FROM node:22-slim AS production
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

COPY --from=base /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=base /app/packages/core/package.json packages/core/
COPY --from=base /app/packages/server/package.json packages/server/
COPY --from=base /app/packages/web/package.json packages/web/
COPY --from=base /app/packages/cli/package.json packages/cli/

RUN pnpm install --frozen-lockfile --prod

COPY --from=base /app/packages/core/dist packages/core/dist/
COPY --from=base /app/packages/server/dist packages/server/dist/
COPY --from=base /app/packages/server/migrations packages/server/migrations/
COPY --from=base /app/packages/web/dist packages/web/dist/
COPY --from=base /app/packages/cli/dist packages/cli/dist/
COPY --from=base /app/workflows workflows/

ENV PORT=3001
ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "packages/server/dist/index.js"]
