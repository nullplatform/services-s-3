# syntax=docker/dockerfile:1
#
# aws-s3-bucket service worker image — the S3 service built on the lean gRPC
# worker bridge. The bridge dials over gRPC and runs the bash entrypoint on
# each package-exec action; this image adds the cloud tooling the S3 steps
# need and bakes the service in, so the channel needs no cmdline.
FROM public.ecr.aws/nullplatform/scopes/worker-bridge:2.0.1

# Tooling the S3 workflows call (the bridge base stays minimal on purpose):
# aws + gomplate from apk. bash, jq, np, base64 and curl ship in the base.
RUN apk add --no-cache aws-cli gomplate

# OpenTofu >= 1.10 — the service inits its S3 backend with use_lockfile=true,
# which needs tofu 1.10+. alpine only packages 1.7.x, so pull the official
# static binary for the build arch.
ARG TOFU_VERSION=1.13.1
ARG TARGETARCH
RUN curl -fsSL "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_linux_${TARGETARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin tofu \
    && tofu version

# Bake the service in and point the bridge at its entrypoint + service path.
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
