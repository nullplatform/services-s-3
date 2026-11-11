/**
 * The bash fallback: everything that is not link mode (service and link actions of the
 * aws-s3-bucket service, and any other command) runs the service's bash entrypoint exactly as
 * worker-bridge v2.0.7 (nullplatform/worker-bridge src/index.ts) did, the image's entrypoint
 * before this worker:
 *
 *   bash $NP_SCOPE_ENTRYPOINT --service-path=$NP_SERVICE_PATH [--overrides-path=<each of NP_OVERRIDES_PATH>]
 *
 * with the worker's environment plus NP_ACTION_CONTEXT = the delivered document, no timeout, and
 * the answer `{ exitCode, stdout, stderr }`: success when bash exits 0. Both streams are mirrored
 * to the worker's own stdout and stderr, as the bridge did.
 *
 * What the SDK (0.4.0) changes on the wire, and only on a failure: its gRPC result carries no
 * data and exit code 1, so the streams are logged instead (stdout at info, stderr at warn), which
 * the agent streams back as the command's stdOut / stdErr, and the failure's message is the
 * bridge's error text.
 */
import { ActionError, type Context } from "@nullplatform/plugin";

/** The bridge's settings, read once from the worker's environment with the bridge's defaults. */
export interface BridgeConfig {
  /** NP_SCOPE_ENTRYPOINT, default /app/entrypoint. */
  entrypoint: string;
  /** NP_SERVICE_PATH, default /app. */
  servicePath: string;
  /** NP_OVERRIDES_PATH, comma-separated, default none. */
  overridesPaths: string[];
  /** The environment bash runs with (NP_ACTION_CONTEXT is set on top of it). */
  env: Record<string, string | undefined>;
}

/** What one run of the entrypoint produced: the bridge's answer, as it was. */
export interface EntrypointRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs the entrypoint with `argv` and `env`; Bun's spawn unless a test gives another. */
export type Spawn = (argv: string[], env: Record<string, string | undefined>) => Promise<EntrypointRun>;

/** The failure code a non-zero exit fails with (the bridge sent none). */
export const ENTRYPOINT_FAILED = "ENTRYPOINT_FAILED";

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/** The bridge's settings from `env`, with worker-bridge's defaults. */
export function bridgeConfigOf(env: Record<string, string | undefined>): BridgeConfig {
  return {
    entrypoint: env.NP_SCOPE_ENTRYPOINT ?? "/app/entrypoint",
    servicePath: env.NP_SERVICE_PATH ?? "/app",
    overridesPaths: list(env.NP_OVERRIDES_PATH),
    env,
  };
}

/** The command line worker-bridge runs. */
export function entrypointArgv({ entrypoint, servicePath, overridesPaths }: BridgeConfig): string[] {
  return ["bash", entrypoint, `--service-path=${servicePath}`, ...overridesPaths.map((path) => `--overrides-path=${path}`)];
}

/** The error text worker-bridge failed with: the end of stderr, else of stdout, else the exit code. */
export function failureMessage({ exitCode, stdout, stderr }: EntrypointRun): string {
  return (stderr || stdout || `entrypoint exited ${exitCode}`).slice(-4000);
}

export const bunSpawn: Spawn = async (argv, env) => {
  const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
};

/** Where the bridge mirrors the entrypoint's streams: the worker's own stdout and stderr. */
export interface Mirror {
  stdout(text: string): void;
  stderr(text: string): void;
}

const processMirror: Mirror = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

/**
 * Runs the entrypoint for `document` (the text NP_ACTION_CONTEXT carries) and answers as the bridge
 * did: `{ exitCode, stdout, stderr }` on exit 0, a failure with the bridge's error text otherwise.
 */
export async function runEntrypoint(document: string, context: Pick<Context, "log">, config: BridgeConfig, spawn: Spawn = bunSpawn, mirror: Mirror = processMirror): Promise<EntrypointRun> {
  const run = await spawn(entrypointArgv(config), { ...config.env, NP_ACTION_CONTEXT: document });
  if (run.stdout) mirror.stdout(run.stdout);
  if (run.stderr) mirror.stderr(run.stderr);
  if (run.exitCode === 0) return { exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr };
  if (run.stdout) context.log.info(run.stdout);
  if (run.stderr) context.log.warn(run.stderr);
  throw new ActionError(ENTRYPOINT_FAILED, failureMessage(run));
}
