import { definePackage } from "@nullplatform/plugin/package";
import manifest from "../package.json" with { type: "json" };
import { bucket, connect } from "./resources";
import * as access from "./access";
import * as s3 from "./bucket";

export default definePackage({
  // Baked in at build time from package.json, so the compiled worker knows
  // who it is wherever it runs.
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  providerCategories: ["cloud-providers", "identity-access-control"],
  resources: [bucket, connect],
  handlers: [
    bucket.handle({ create: s3.create, update: s3.update, delete: s3.remove }),
    connect.handle({ create: access.create, update: access.update, delete: access.remove }),
  ],
});
