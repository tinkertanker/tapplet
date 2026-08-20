import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  liveImageFixture,
  readLiveImageFixture,
} from "./lib/live-image-fixture.mjs";

test("live verification uses a small deterministic classroom image", () => {
  const bytes = readLiveImageFixture();

  assert.ok(bytes.length > 0);
  assert.ok(bytes.length <= 2_000_000);
  assert.equal(liveImageFixture.mediaType, "image/png");
  assert.equal(liveImageFixture.width, 600);
  assert.equal(liveImageFixture.height, 340);
  assert.match(liveImageFixture.alternativeText, /balanced-forces diagram/i);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "767daab2fc53de67ea3da2326310e10815bdc63f3767e8203912df52729a64a8",
  );
});
