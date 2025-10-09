# Multi-stage Dockerfile for NestJS app

# 1) Base dependencies stage
FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies separately for better layer caching
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit

# 2) Build stage
FROM base AS build
WORKDIR /app
COPY tsconfig*.json ./
COPY nest-cli.json ./
COPY src ./src
# Build the application (Nest CLI is available via devDependencies from base layer)
RUN npm run build

# 3) Production dependencies (prune dev deps)
FROM base AS prod-deps
WORKDIR /app
RUN npm prune --omit=dev --ignore-scripts --no-audit

# 4) Runtime image
FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app

# Create non-root user with fixed UID/GID for consistent permissions
RUN addgroup -S -g 1001 appgroup \
  && adduser -S -u 1001 -G appgroup appuser

# Copy built artifacts and production node_modules
COPY --chown=appuser:appgroup --from=build /app/dist ./dist
COPY --chown=appuser:appgroup package*.json ./
COPY --chown=appuser:appgroup --from=prod-deps /app/node_modules ./node_modules

# Expose app port
EXPOSE 3000

USER appuser
CMD ["node", "dist/main.js"]


