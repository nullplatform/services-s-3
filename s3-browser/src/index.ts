/**
 * s3-browser: the worker behind the S3 browser UI plugin. The dashboard calls
 * `POST /controlplane/agent_command` (type package-exec, package s3-browser); the agent spawns
 * this image and hands the command over gRPC; the worker resolves the bucket from the
 * nullplatform service and reads S3 with its own identity. Nothing is exposed inbound.
 */
import pkg from "../package.json";
import { createPlugin, registerManifest } from "@nullplatform/plugin";
import { createHandler, runCommand } from "./handler";
import { createPlatform } from "./platform";
import { createS3 } from "./s3";

export const SLUG = "s3-browser";

const manifest = {
  name: SLUG,
  version: pkg.version,
  command_types: ["custom"],
  agent: {
    selector: { package: SLUG },
    sources: ["service"],
  },
};
registerManifest(manifest);

// `np package publish` reads the manifest from `--describe`; a raw createPlugin has no
// built-in handler for it.
if (process.argv.includes("--describe")) {
  process.stdout.write(JSON.stringify(manifest));
  process.exit(0);
}

const env = process.env;
// Credentials come from IRSA, container credentials or the environment. The instance metadata
// leg of the default chain is disabled unless asked for: in a container without a route to
// 169.254.169.254 the connect attempt hangs long past the caller's timeout (bun does not abort
// a pending connect on the SDK's timeout).
if (env.S3_BROWSER_ALLOW_IMDS !== "1" && !env.AWS_EC2_METADATA_DISABLED) env.AWS_EC2_METADATA_DISABLED = "true";
const list = (value: string | undefined, fallback: string) =>
  (value ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const handler = createHandler({
  platform: createPlatform({ apiUrl: env.NP_API_URL, apiKey: env.NP_API_KEY }),
  store: createS3({ defaultRegion: env.AWS_REGION, downloadTtlSeconds: Number(env.S3_BROWSER_DOWNLOAD_TTL_SECONDS ?? 900) }),
  config: {
    specifications: list(env.S3_BROWSER_SPECIFICATIONS, "aws-s3-bucket*"),
    allowWrites: env.S3_BROWSER_ALLOW_WRITES === "1",
  },
});

createPlugin({
  async execute(req) {
    // No streamed output: every emitted line becomes a partial update on the caller's
    // response, and the result must stay one JSON document on stdout.
    const started = Date.now();
    const result = await runCommand(req.payload, handler);
    console.error(`[s3-browser] ${result.success ? "completed" : "failed"} in ${Date.now() - started} ms`);
    return result;
  },
}).start();
