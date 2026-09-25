import { definePackage } from "@nullplatform/plugin/package";
import { bucket, connect } from "./resources";
import * as bucketHandlers from "./bucket";
import * as access from "./access";

export default definePackage({
  // name, version and description come from package.json
  providerCategories: ["cloud-providers", "identity-access-control"],
  resources: [bucket, connect],
  handlers: [
    bucket.handle({ create: bucketHandlers.create.fn, update: bucketHandlers.update.fn, delete: bucketHandlers.remove.fn }),
    connect.handle({ create: access.create.fn, update: access.update.fn, delete: access.remove.fn }),
  ],
});
