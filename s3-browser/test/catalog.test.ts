import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The catalog documents must agree with the service action specifications:
// one worker answers both, so an input or output that drifts between the two
// would validate on one side and fail on the other.

const root = join(import.meta.dir, "..");
const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

const specification = read("catalog/aws-s3-bucket.specification.json");
const executors: Array<{ action: string; transport: string; timeout_ms: number }> = read("catalog/executors.json");
const channel = read("catalog/channel.example.json");
const serviceActions = readdirSync(join(root, "actions"))
  .filter((file) => file.endsWith(".json"))
  .map((file) => read(join("actions", file)));

const slugs = serviceActions.map((action) => action.slug).sort();

describe("aws-s3-bucket catalog specification", () => {
  test("declares actions and authorization inside the schema, keyed by slug", () => {
    expect(specification.slug).toBe("aws-s3-bucket");
    expect(Object.keys(specification.schema.actions).sort()).toEqual(slugs);
    expect(specification.schema.authorization.entities.grants.length).toBeGreaterThan(0);
  });

  test("every action is sync and mirrors its service action specification", () => {
    for (const serviceAction of serviceActions) {
      const action = specification.schema.actions[serviceAction.slug];
      expect(action.name).toBe(serviceAction.name);
      expect(action.execution).toBe("sync");
      expect(action.input).toEqual(serviceAction.parameters.schema);
      expect(action.output).toEqual(serviceAction.results.schema);
      expect(action.permission).toBe(serviceAction.permission);
    }
  });

  test("grants cover every read action and name the delete permission only through its action", () => {
    const granted = new Set(
      specification.schema.authorization.entities.grants.flatMap((grant: { actions: string[] }) => grant.actions),
    );
    for (const slug of slugs) {
      const action = specification.schema.actions[slug];
      if (action.permission) {
        expect(granted.has(`action:${slug}`)).toBe(false);
      } else {
        expect(granted.has(`action:${slug}`)).toBe(true);
      }
    }
  });

  test("has one notification executor per action", () => {
    expect(executors.map((executor) => executor.action).sort()).toEqual(slugs);
    for (const executor of executors) {
      expect(executor.transport).toBe("notification");
      expect(executor.timeout_ms).toBeGreaterThan(0);
    }
  });

  test("the channel example routes catalog executions of this specification", () => {
    expect(channel.source).toEqual(["catalog"]);
    expect(JSON.stringify(channel.filters)).toContain("catalog:action:create");
    expect(JSON.stringify(channel.filters)).toContain("aws-s3-bucket");
    expect(channel.configuration.command.data.environment.NP_ACTION_CONTEXT).toBe("${NOTIFICATION_CONTEXT}");
  });
});
