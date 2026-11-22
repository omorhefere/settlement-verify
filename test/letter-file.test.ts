import { describe, expect, it } from "vitest";
import { checkLetterFile, MAX_IMAGE_BYTES } from "../src/extractors/letter-file.ts";

// Builds a fake file from its first bytes, so the type check has something to read.
const fileStartingWith = (firstBytes: number[] | string, totalLength = 64): Buffer => {
  const start = typeof firstBytes === "string" ? Buffer.from(firstBytes, "latin1") : Buffer.from(firstBytes);
  return Buffer.concat([start, Buffer.alloc(Math.max(0, totalLength - start.length))]);
};

describe("checkLetterFile", () => {
  it.each([
    ["PDF", fileStartingWith("%PDF-1.7"), "application/pdf"],
    ["JPEG", fileStartingWith([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    ["PNG", fileStartingWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    ["GIF", fileStartingWith("GIF89a"), "image/gif"],
    ["WebP", fileStartingWith("RIFF\x00\x00\x00\x00WEBPVP8 "), "image/webp"],
  ])("recognises a %s", (_, letterFile, mediaType) => {
    expect(checkLetterFile(letterFile)).toEqual({ isSupported: true, mediaType });
  });

  it("goes by the file's bytes, not its name", () => {
    expect(checkLetterFile(Buffer.from("just some text pretending to be a pdf"))).toMatchObject({ isSupported: false });
  });

  it("explains that iPhone HEIC photos need converting", () => {
    const heicPhoto = fileStartingWith("\x00\x00\x00\x18ftypheic");
    expect(checkLetterFile(heicPhoto)).toEqual({
      isSupported: false,
      reason: "iPhone HEIC photos aren't supported. Please upload a JPEG or PNG photo, or a PDF.",
    });
  });

  it("refuses photos over 5 MB, but not PDFs of the same size", () => {
    const bigPhoto = fileStartingWith([0xff, 0xd8, 0xff, 0xe0], MAX_IMAGE_BYTES + 1);
    const bigPdf = fileStartingWith("%PDF-1.7", MAX_IMAGE_BYTES + 1);
    expect(checkLetterFile(bigPhoto)).toMatchObject({ isSupported: false });
    expect(checkLetterFile(bigPdf)).toMatchObject({ isSupported: true, mediaType: "application/pdf" });
  });
});
