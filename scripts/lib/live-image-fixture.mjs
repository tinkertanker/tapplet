import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

const fixtureURL = new URL(
  "../fixtures/live-api/balanced-forces.png.base64",
  import.meta.url,
);
const blockedMetadataChunks = new Set(["eXIf", "iTXt", "tEXt", "zTXt"]);

export const liveImageFixture = Object.freeze({
  mediaType: "image/png",
  width: 600,
  height: 340,
  alternativeText:
    "Balanced-forces diagram showing equal 5-newton arrows acting in opposite directions on a block.",
});

export function readLiveImageFixture() {
  const encoded = readFileSync(fixtureURL, "utf8").replaceAll(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new Error("The live image fixture is not valid base64.");
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length < 8 ||
    !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    throw new Error("The live image fixture is not a valid PNG.");
  }

  let offset = 8;
  let width;
  let height;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (next > bytes.length)
      throw new Error("The live image fixture contains a truncated PNG chunk.");
    if (blockedMetadataChunks.has(type))
      throw new Error(`The live image fixture contains blocked ${type} metadata.`);
    if (type === "IHDR") {
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
    }
    offset = next;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd || offset !== bytes.length)
    throw new Error("The live image fixture has an invalid PNG ending.");
  if (width !== liveImageFixture.width || height !== liveImageFixture.height) {
    throw new Error(
      `The live image fixture must be ${liveImageFixture.width}x${liveImageFixture.height}.`,
    );
  }
  return bytes;
}
