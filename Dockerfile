FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run typecheck
RUN npx vite build apps/web

EXPOSE 8000 9000

CMD ["npx", "tsx", "apps/gateway/src/main.ts"]
