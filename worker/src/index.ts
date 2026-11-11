/**
 * The services/s3 image's worker. The controlplane agent spawns the image and hands it every
 * command over gRPC; catalog executions of the `s3_browser` specification are the S3 browser's
 * (link mode, the link's own keys or role), and everything else runs the aws-s3-bucket bash
 * entrypoint as worker-bridge did (see plugin.ts). Nothing is exposed inbound.
 */
import { main } from "@nullplatform/plugin";
import { bridgeConfigOf, type Mirror } from "./bridge";
import { createHandler } from "./handler";
import { DEFAULT_LINK_SECRETS_QUERY, createPlatform } from "./platform";
import { createWorker } from "./plugin";
import { DEFAULT_LINK_SPECIFICATION } from "./protocol";
import { createS3 } from "./s3";

// bash runs with the environment the worker started with, as worker-bridge's did: taken before
// the S3 browser's own setting below.
const startEnv = { ...process.env };
const env = process.env;
// STS's source credentials come from IRSA, container credentials or the environment. The instance
// metadata leg of the default chain is disabled unless asked for: in a container without a route
// to 169.254.169.254 the connect attempt hangs long past the caller's timeout (bun does not abort a
// pending connect on the SDK's timeout).
if (env.S3_BROWSER_ALLOW_IMDS !== "1" && !env.AWS_EC2_METADATA_DISABLED) env.AWS_EC2_METADATA_DISABLED = "true";

const list = (value: string | undefined, fallback: string) =>
  (value ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

// Serving the agent's gRPC protocol, the bash streams are mirrored as the bridge did; answering an
// exec'd document (a local run), stdout is the answer, so both go to stderr.
const serving = env.NP_AGENT_PLUGIN?.trim() === "np-agent-v1" || Boolean(env.NP_GRPC_LISTEN?.trim());
const stderrOnly: Mirror = { stdout: (text) => void process.stderr.write(text), stderr: (text) => void process.stderr.write(text) };

const worker = createWorker({
  package: { name: env.NP_PACKAGE_NAME ?? "worker", version: env.NP_PACKAGE_VERSION ?? "0.0.0" },
  sources: list(env.NP_AGENT_SOURCES, "service,telemetry"),
  commandTypes: list(env.NP_COMMAND_TYPES, "scope,service,action"),
  link: {
    handler: createHandler({
      platform: createPlatform({ apiUrl: env.NP_API_URL, apiKey: env.NP_API_KEY, linkSecretsQuery: env.S3_BROWSER_LINK_SECRETS_QUERY ?? DEFAULT_LINK_SECRETS_QUERY }),
      store: createS3({ defaultRegion: env.AWS_REGION, downloadTtlSeconds: Number(env.S3_BROWSER_DOWNLOAD_TTL_SECONDS ?? 900) }),
      config: {
        specifications: list(env.S3_BROWSER_SPECIFICATIONS, "aws-s3-bucket*"),
        allowWrites: env.S3_BROWSER_ALLOW_WRITES === "1",
        // DEMO ONLY, never in a customer organization: see catalog/LINK_MODE.md.
        unverifiedEntityBinding: env.S3_BROWSER_UNVERIFIED_ENTITY_BINDING === "1",
        // Role links: their roles live in this account; unset refuses them (LINK_ROLE_NOT_CONFIGURED).
        linkRole: { accountId: env.S3_BROWSER_LINK_ROLE_ACCOUNT_ID, partition: env.S3_BROWSER_LINK_ROLE_PARTITION || "aws" },
      },
    }),
    parse: { linkSpecification: env.S3_BROWSER_LINK_SPECIFICATION || DEFAULT_LINK_SPECIFICATION },
  },
  bridge: { ...bridgeConfigOf(startEnv), ...(serving ? {} : { mirror: stderrOnly }) },
});

await main(worker);
