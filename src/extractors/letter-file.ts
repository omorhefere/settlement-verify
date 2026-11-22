// Working out what kind of file a customer uploaded, from its first bytes
// (its "magic number"), not its file name, which can't be trusted.
// Customers upload settlement letters as PDFs or as photos.

// The file types the models can read directly.
export type LetterMediaType = "application/pdf" | "image/jpeg" | "image/png" | "image/gif" | "image/webp";

// The result of looking at an uploaded file: a type we can send to the model,
// or a reason we can't.
export type LetterFileCheck =
  | { isSupported: true; mediaType: LetterMediaType }
  | { isSupported: false; reason: string };

// Images sent to the model must be 5 MB or smaller; phone photos can be
// bigger, so they need resizing first.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const startsWith = (file: Buffer, bytes: number[], offset = 0): boolean =>
  bytes.every((byte, index) => file[offset + index] === byte);

const asciiAt = (file: Buffer, offset: number, length: number): string =>
  file.subarray(offset, offset + length).toString("latin1");

// Detects the file type from its first bytes. Unsupported types (iPhone HEIC
// photos, Word documents, anything else) come back with a reason the customer
// can act on.
export const checkLetterFile = (letterFile: Buffer): LetterFileCheck => {
  if (asciiAt(letterFile, 0, 5) === "%PDF-") return { isSupported: true, mediaType: "application/pdf" };

  let imageType: LetterMediaType | undefined;
  if (startsWith(letterFile, [0xff, 0xd8, 0xff])) imageType = "image/jpeg";
  else if (startsWith(letterFile, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) imageType = "image/png";
  else if (asciiAt(letterFile, 0, 4) === "GIF8") imageType = "image/gif";
  else if (asciiAt(letterFile, 0, 4) === "RIFF" && asciiAt(letterFile, 8, 4) === "WEBP") imageType = "image/webp";

  if (imageType) {
    if (letterFile.length > MAX_IMAGE_BYTES) {
      return { isSupported: false, reason: "The photo is too large (over 5 MB). Please upload a smaller photo or a PDF." };
    }
    return { isSupported: true, mediaType: imageType };
  }

  // iPhone photos: "ftyp" then a HEIC brand, from byte 4.
  if (asciiAt(letterFile, 4, 4) === "ftyp" && ["heic", "heix", "mif1", "msf1"].includes(asciiAt(letterFile, 8, 4))) {
    return { isSupported: false, reason: "iPhone HEIC photos aren't supported. Please upload a JPEG or PNG photo, or a PDF." };
  }
  return { isSupported: false, reason: "Please upload your letter as a PDF or a photo (JPEG, PNG, GIF or WebP)." };
};
