import { definePackage } from "@nullplatform/plugin/package";
import manifest from "../package.json" with { type: "json" };
import { bucket, connect } from "./resources";
import * as bucketHandlers from "./bucket";
import * as access from "./access";

export default definePackage({
  // Baked in at build time from package.json, so the compiled worker knows
  // who it is wherever it runs.
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  providerCategories: ["cloud-providers", "identity-access-control"],
  resources: [bucket, connect],
  handlers: [
    bucket.handle({ create: bucketHandlers.create.fn, update: bucketHandlers.update.fn, delete: bucketHandlers.remove.fn }),
    connect.handle({ create: access.create.fn, update: access.update.fn, delete: access.remove.fn }),
  ],
});
