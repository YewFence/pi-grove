import { fileURLToPath } from "node:url";
import { verifyShipManifest } from "./helpers/index.js";
import { describe, expect, it } from "vitest";

describe("publish manifest", () => {
  it("`package.json` `files` array covers every production .ts module across the tree", () => {
    expect(verifyShipManifest(fileURLToPath(new URL("../", import.meta.url))).missing).toEqual([]);
  });
});
