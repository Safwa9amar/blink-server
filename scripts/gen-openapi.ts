// Writes openapi.json from the route definitions (no server boot, no network).
// The mobile app copies this file and runs orval against it.
import { writeFileSync } from "node:fs";
import app, { VERSION } from "../src/app";
import { openapiConfig } from "../src/openapi";

const doc = app.getOpenAPIDocument(openapiConfig(VERSION) as any);
doc.components = {
  ...doc.components,
  securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
};
writeFileSync("openapi.json", JSON.stringify(doc, null, 2) + "\n");
console.log(`openapi.json: ${Object.keys(doc.paths ?? {}).length} paths`);
process.exit(0);
