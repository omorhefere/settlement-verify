import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { makeAnthropicExtractor } from "../src/extractors/anthropic.ts";
import { cleanLetterExtraction } from "./fixtures.ts";

// No real API calls: a fake client stands in for the SDK.
const fakeClientReturning = (response: object) => {
  const fakeParse = vi.fn().mockResolvedValue(response);
  return { client: { messages: { parse: fakeParse } } as unknown as Anthropic, fakeParse };
};

const fakeLetterPdf = Buffer.from("%PDF-1.4 fake");

describe("makeAnthropicExtractor", () => {
  it("sends the PDF as a base64 document with the pinned model and max_tokens", async () => {
    const { client, fakeParse } = fakeClientReturning({ stop_reason: "end_turn", parsed_output: cleanLetterExtraction() });
    await makeAnthropicExtractor({ client, model: "claude-haiku-5-5", maxTokens: 2000 })(fakeLetterPdf);

    const request = fakeParse.mock.calls[0]![0];
    expect(request.model).toBe("claude-haiku-5-5");
    expect(request.max_tokens).toBe(2000);
    expect(request.messages[0].content[0]).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: fakeLetterPdf.toString("base64") },
    });
    expect(request.output_config.format).toBeDefined();
  });

  it("returns the parsed extraction", async () => {
    const { client } = fakeClientReturning({ stop_reason: "end_turn", parsed_output: cleanLetterExtraction() });
    await expect(makeAnthropicExtractor({ client, model: "m" })(fakeLetterPdf)).resolves.toEqual(cleanLetterExtraction());
  });

  it.each([
    [{ stop_reason: "max_tokens", parsed_output: null }, /truncated/],
    [{ stop_reason: "refusal", parsed_output: null }, /refused/],
    [{ stop_reason: "end_turn", parsed_output: null }, /didn't match/],
  ])("throws instead of returning bad output: %j", async (response, message) => {
    const { client } = fakeClientReturning(response);
    await expect(makeAnthropicExtractor({ client, model: "m" })(fakeLetterPdf)).rejects.toThrow(message);
  });
});

describe("makeAnthropicExtractor with photos", () => {
  // The first bytes of a PNG file, then filler: enough for the type check.
  const fakeLetterPhoto = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake png")]);

  it("sends a photo as a base64 image block", async () => {
    const { client, fakeParse } = fakeClientReturning({ stop_reason: "end_turn", parsed_output: cleanLetterExtraction() });
    await makeAnthropicExtractor({ client, model: "m" })(fakeLetterPhoto);
    expect(fakeParse.mock.calls[0]![0].messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: fakeLetterPhoto.toString("base64") },
    });
  });

  it("refuses a file type the model can't read, without calling the model", async () => {
    const { client, fakeParse } = fakeClientReturning({ stop_reason: "end_turn", parsed_output: cleanLetterExtraction() });
    await expect(makeAnthropicExtractor({ client, model: "m" })(Buffer.from("not a letter"))).rejects.toThrow(/Unsupported letter file/);
    expect(fakeParse).not.toHaveBeenCalled();
  });
});
