# SambaEval frontend image — Next.js (app/ + package.json at the product root).
# Build context is the product root (`sambaeval/`).
#
#   docker build -t sambaeval-frontend:local .
#
# Runs `next start -p 3001` (the `start` script). At build time Next.js bakes
# NEXT_PUBLIC_* vars in; for same-origin `/api` behind the ingress the default
# empty base is fine, so we only pass NEXT_PUBLIC_API_BASE_URL for local dev.

# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app

# Install deps against the lockfile first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Build the production bundle.
COPY . .
RUN npm run build

# ---- runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# Copy only what `next start` needs at runtime.
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./next.config.ts

# node:alpine ships an unprivileged `node` user.
USER node
EXPOSE 3001

CMD ["npm", "run", "start"]
