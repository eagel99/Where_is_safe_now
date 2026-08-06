# Build stage: resolve production dependencies with a full Node image, so the
# runtime image never needs npm or a shell.
FROM node:22-bookworm-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Staged empty state directory. The runtime image is distroless and has no
# shell, so the directory has to be created here to exist with the right owner.
RUN mkdir -p /state

# Runtime stage. Pin the base image by digest for reproducible, tamper-proof
# builds; read the current digest from the RepoDigests field of a
# "docker inspect" on gcr.io/distroless/nodejs22-debian12 after pulling it.
FROM gcr.io/distroless/nodejs22-debian12:latest

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY data ./data
COPY config ./config

# Event log, snapshot and segment cache. Must be owned by the runtime user, or
# the first snapshot write fails with EACCES.
COPY --from=deps --chown=nonroot:nonroot /state ./.data
VOLUME ["/app/.data"]

EXPOSE 3000

USER nonroot

CMD ["src/index.js"]
