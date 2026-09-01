# syntax=docker/dockerfile:1
#
# aws-s3-bucket service worker image — the S3 service built on the lean gRPC
# worker bridge. The bridge dials over gRPC and runs the bash entrypoint on
# each package-exec action; this image adds the cloud tooling the S3 steps
# need and bakes the service in, so the channel needs no cmdline.
FROM public.ecr.aws/nullplatform/scopes/worker-bridge:1.0.0

# Tooling the S3 workflows call (the bridge base stays minimal on purpose):
# aws + gomplate from apk. bash, jq, np, base64 and curl ship in the base.
RUN apk add --no-cache aws-cli gomplate

# OpenTofu >= 1.10 — the service inits its S3 backend with use_lockfile=true,
# which needs tofu 1.10+. alpine only packages 1.7.x, so pull the official
# static binary for the build arch.
ARG TOFU_VERSION=1.10.10
ARG TARGETARCH
RUN curl -fsSL "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${TARGETARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin tofu \
    && tofu version

# Bake the service in and point the bridge at its entrypoint + service path.
COPY . /app/pkg
ENV NP_PACKAGE_NAME=aws-s3-bucket \
    NP_SERVICE_PATH=/app/pkg/aws-s3-bucket \
    NP_SCOPE_ENTRYPOINT=/app/pkg/aws-s3-bucket/entrypoint/entrypoint
