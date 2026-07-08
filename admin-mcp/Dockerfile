# Mike AdminMax MCP — FastMCP httpStream server (Cloud Run).
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Cloud Run injects PORT; the server reads it (default 8080).
EXPOSE 8080
CMD ["node", "dist/server.js"]
