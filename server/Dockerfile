FROM node:24-bookworm-slim AS build

WORKDIR /build
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/dist ./dist
COPY domain-verification ./domain-verification

EXPOSE 3000
CMD ["node", "dist/index.js"]
