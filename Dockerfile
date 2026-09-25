# syntax=docker/dockerfile:1
#
# aws-s3-bucket worker image: the package compiled to one binary. The agent
# starts it and dials it over gRPC; it answers every action of the service
# and its link with the AWS SDK. No shell, no CLI, no Terraform.
FROM oven/bun:1-alpine AS build
WORKDIR /opt/aws-s3-bucket
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY src ./src
# Compile for the image's own architecture (bun names amd64 "x64").
ARG TARGETARCH
RUN arch=$([ "$TARGETARCH" = "amd64" ] && echo x64 || echo "$TARGETARCH") \
    && bun build --compile --target="bun-linux-${arch}-musl" src/main.ts --outfile /out/aws-s3-bucket

FROM alpine:3.20
RUN apk add --no-cache ca-certificates libstdc++ libgcc \
    && addgroup -S -g 65532 np-service-aws-s3-bucket \
    && adduser -S -u 65532 -G np-service-aws-s3-bucket -h /home/worker np-service-aws-s3-bucket
COPY --from=build /out/aws-s3-bucket /app/packages/aws-s3-bucket/entrypoint
USER 65532
ENV HOME=/home/worker \
    SUPPRESS_NO_CONFIG_WARNING=1 \
    NP_AGENT_PLUGIN=np-agent-v1
ENTRYPOINT ["/app/packages/aws-s3-bucket/entrypoint"]
