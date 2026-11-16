# syntax=docker/dockerfile:1
# Lean gRPC worker image: the controlplane agent spawns it (a pod in Kubernetes, a container
# in Docker) and streams package-exec commands to it over gRPC/mTLS. NP_AGENT_PLUGIN makes the
# binary start the SDK's gRPC server; the agent injects NP_GRPC_LISTEN, NP_WORKER_TLS_* and
# NP_API_KEY at spawn. AWS credentials come from the pod (IRSA) or the worker env.
FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock* .npmrc ./
RUN bun install --frozen-lockfile || bun install
COPY . .
ARG TARGETARCH
RUN if [ "$TARGETARCH" = "arm64" ]; then t=bun-linux-arm64-musl; else t=bun-linux-x64-musl; fi; \
    bun build --compile --target="$t" ./src/index.ts --outfile /app/worker

FROM alpine:3.20
RUN apk add --no-cache libstdc++ libgcc ca-certificates
COPY --from=build /app/worker /app/worker
COPY config/ /app/config/
ENV NODE_CONFIG_DIR=/app/config \
    SUPPRESS_NO_CONFIG_WARNING=1 \
    NP_AGENT_PLUGIN=np-agent-v1
EXPOSE 50051
ENTRYPOINT ["/app/worker"]
