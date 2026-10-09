# DEV ONLY — arch ⇄ online row sync worker (see sync.mjs).
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY sync.mjs ./
USER node
CMD ["node", "sync.mjs"]
