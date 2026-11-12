import { describe, expect, test } from "bun:test";
import { CommandError, parseCommand } from "../src/protocol";

describe("parseCommand", () => {
  test("accepts a flat listing command with defaults", () => {
    expect(parseCommand(Buffer.from(JSON.stringify({ action: "list-objects", service_id: "svc-1" })))).toEqual({ action: "list-objects", service_id: "svc-1", prefix: "", token: undefined, limit: 200, key: undefined });
  });

  test("accepts the command nested next to the platform's notification", () => {
    const payload = JSON.stringify({ notification: { package: { slug: "s3-browser" } }, command: { action: "head-object", service_id: "svc-1", key: "docs/a.txt" } });
    expect(parseCommand(payload).key).toBe("docs/a.txt");
  });

  test("rejects unknown actions, absolute keys and silly limits", () => {
    expect(() => parseCommand({ action: "rm-rf", service_id: "svc-1" })).toThrow(CommandError);
    expect(() => parseCommand({ action: "head-object", service_id: "svc-1", key: "/etc/passwd" })).toThrow(/key is required/);
    expect(() => parseCommand({ action: "list-objects", service_id: "svc-1", limit: 5000 })).toThrow(/limit/);
    expect(() => parseCommand({ action: "list-objects" })).toThrow(/service_id/);
    expect(() => parseCommand("not json")).toThrow(/JSON/);
  });
});
