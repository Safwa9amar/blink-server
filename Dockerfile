# Multi-stage build for the Blink API.
#
# The build uses esbuild (`npm run build`) with --packages=external, so it
# inlines all *local* src/ imports into a single dist/index.js but leaves
# node_modules deps to be resolved at runtime — hence the runtime stage keeps
# the production dependencies.

# ---- build stage: all deps + esbuild bundle ----
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build                     # -> dist/index.js

# ---- runtime stage: prod deps + bundle only ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3001
# serve() listens on env.PORT (set PORT=3001 in .env). No tsx at runtime.
CMD ["node", "dist/index.js"]
