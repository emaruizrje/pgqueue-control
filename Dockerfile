# ---- Stage 1: build the Angular dashboard -> /app/public ----
FROM node:22-alpine AS dashboard
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
# angular.json outputPath is ../public, so this emits to /app/public
RUN npm run build

# ---- Stage 2: runtime (API + built dashboard) ----
FROM node:22-alpine AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
# tsx (devDependency) is the runtime for the TS sources, so install everything
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY demo ./demo
COPY scripts ./scripts
COPY --from=dashboard /app/public ./public

EXPOSE 4400
CMD ["npx", "tsx", "src/api/server.ts"]
