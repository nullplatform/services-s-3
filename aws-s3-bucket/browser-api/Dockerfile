# syntax=docker/dockerfile:1
# The S3 browser backend: a small Node service that lists and presigns objects of an
# aws-s3-bucket service for the dashboard's S3 browser plugin. Build from this directory.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src src
EXPOSE 8080
USER node
CMD ["node", "src/index.mjs"]
