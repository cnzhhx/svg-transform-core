// Copied into a temporary consumer and compiled against the installed tarball.
import { CoreClientError, createSvgTransformClient } from "@svg-transform/core-client";

const client = createSvgTransformClient({
  baseUrl: "https://core.example.test",
  fetch: async () => new Response("ok"),
});

if (await client.health() !== "ok") {
  throw new Error("Packed SDK health request failed");
}
if (typeof CoreClientError !== "function") {
  throw new Error("Packed SDK is missing its error export");
}
