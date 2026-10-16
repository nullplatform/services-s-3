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

describe("parseCommand: service-action envelope", () => {
  const defaultService = { id: "svc-1", specification: { slug: "aws-s3-bucket" }, attributes: { bucket_name: "bucket-placeholder", bucket_region: "eu-west-1" } };
  const envelope = (slug: string, parameters: unknown) => JSON.stringify({ notification: { specification: { slug }, parameters, service: defaultService } });

  test("list-objects", () => {
    expect(parseCommand(envelope("list-objects", { prefix: "docs/", limit: 10, token: "t" }))).toEqual({
      action: "list-objects", service_id: "svc-1", prefix: "docs/", token: "t", limit: 10, key: undefined,
      service: { attributes: { bucket_name: "bucket-placeholder", bucket_region: "eu-west-1" }, specification_slug: "aws-s3-bucket" },
    });
  });

  test("head-object, presign-download and delete-object take a key", () => {
    for (const slug of ["head-object", "presign-download", "delete-object"]) {
      expect(parseCommand(envelope(slug, { key: "docs/a.txt" }))).toMatchObject({ action: slug, service_id: "svc-1", key: "docs/a.txt" });
      expect(() => parseCommand(envelope(slug, {}))).toThrow(/key is required/);
    }
  });

  test("missing parameters mean defaults, an unknown slug is refused", () => {
    expect(parseCommand(envelope("list-objects", undefined))).toMatchObject({ prefix: "", limit: 200 });
    expect(() => parseCommand(envelope("rm-rf", {}))).toThrow(/unknown action/);
  });

  test("a service_id or action smuggled in parameters cannot override the envelope", () => {
    expect(parseCommand(envelope("list-objects", { service_id: "other", action: "delete-object" }))).toMatchObject({ action: "list-objects", service_id: "svc-1" });
  });

  test("the legacy shapes still parse", () => {
    expect(parseCommand({ action: "list-objects", service_id: "svc-1" }).service).toBeUndefined();
    expect(parseCommand({ notification: { package: { slug: "s3-browser" } }, command: { action: "list-objects", service_id: "svc-1" } }).action).toBe("list-objects");
  });
});
