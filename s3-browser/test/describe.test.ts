import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("--describe", () => {
  test("prints the manifest np package publish reads", async () => {
    const proc = Bun.spawn(["bun", resolve(import.meta.dir, "../src/index.ts"), "--describe"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, NP_MODE: "dev" } });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ name: "s3-browser", command_types: ["custom"], agent: { selector: { package: "s3-browser" } } });
  });
});
