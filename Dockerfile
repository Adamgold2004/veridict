FROM node:22-alpine
WORKDIR /app

# Native build tools for better-sqlite3; harmless when using Postgres.
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

EXPOSE 3000
CMD ["node", "server/index.js"]
