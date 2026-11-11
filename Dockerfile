# syntax=docker/dockerfile:1
#
# services/s3 worker image: the aws-s3-bucket service and the S3 browser in one worker. The
# controlplane agent dials it over gRPC and hands it every command: catalog executions of the
# `s3_browser` specification are answered by the S3 browser (link mode, with the link's own keys
# or role); everything else runs the service's bash entrypoint exactly as worker-bridge did. See
# worker/README.md.

# ── stage 1: compile the worker (worker/) to a static musl binary ──────────
FROM oven/bun:1-alpine AS build
WORKDIR /w
COPY worker/package.json worker/bun.lock worker/.npmrc ./
RUN bun install --frozen-lockfile --production
COPY worker/src ./src
ARG TARGETARCH
RUN if [ "$TARGETARCH" = "arm64" ]; then t=bun-linux-arm64-musl; else t=bun-linux-x64-musl; fi; \
    bun build --compile --target="$t" ./src/index.ts --outfile /w/worker

# ── stage 2: worker-bridge's runtime, with our worker as its entrypoint ────
# The base brings what the bash service needs and the bridge already provided: bash, jq, curl,
# ca-certificates, openssl, the np CLI on the default PATH, the libstdc++/libgcc a bun musl binary
# links, the app user (10001) with a writable HOME, NP_AGENT_PLUGIN=np-agent-v1 and
# ENTRYPOINT ["worker"]. Only its `worker` binary (the bridge) is replaced, by ours, which keeps
# the bridge's behaviour for every command that is not the S3 browser's.
FROM public.ecr.aws/nullplatform/scopes/worker-bridge:2.0.7

# Tooling the S3 workflows call (the bridge base stays minimal on purpose):
# aws + gomplate from apk. bash, jq, np, base64 and curl ship in the base.
RUN apk add --no-cache aws-cli gomplate

# OpenTofu >= 1.10 — the service inits its S3 backend with use_lockfile=true,
# which needs tofu 1.10+. alpine only packages 1.7.x, so pull the official
# static binary for the build arch.
ARG TOFU_VERSION=1.13.2
ARG TARGETARCH
RUN curl -fsSL "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${TARGETARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin tofu \
    && tofu version

# The worker in the bridge's place: the base's ENTRYPOINT ["worker"] now starts it.
COPY --from=build /w/worker /usr/local/bin/worker

# Bake the service in and point the worker at its entrypoint + service path.
# --chown so the files belong to the uid this image runs as: the tofu steps
# copy the module out to /tmp before init, but `np` chmods the action script
# in place and a root-owned tree would be read-only at runtime.
COPY --chown=10001:10001 . /app/pkg
ENV NP_PACKAGE_NAME=aws-s3-bucket \
    NP_SERVICE_PATH=/app/pkg/aws-s3-bucket \
    NP_SCOPE_ENTRYPOINT=/app/pkg/aws-s3-bucket/entrypoint/entrypoint

# Drop root for the runtime. Everything above installs as root, as usual; the
# base (worker-bridge 2.0.0+) ships the app user, np on PATH and a writable
# HOME, and leaves the switch to each image. Numeric on purpose: k8s
# admission with runAsNonRoot resolves USER to a numeric id to prove it
# isn't root, and a name doesn't satisfy that check.
USER 10001:10001
