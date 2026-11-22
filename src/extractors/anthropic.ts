import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { LetterExtraction } from "../extraction.ts";
import { checkLetterFile } from "./letter-file.ts";
import { EXTRACTION_SYSTEM_PROMPT } from "./prompt.ts";
import type { LetterExtractor } from "./types.ts";

// The config an Anthropic letter extractor is built with.
export type AnthropicExtractorOptions = {
  client: Anthropic; // injected, so tests can pass a fake and config picks the key
  model: string; // pinned model ID from config, e.g. "claude-haiku-5-5"
  maxTokens?: number; // most tokens the model may write back (default 4096); always set: caps cost and avoids truncated JSON surprises
  // Called after every call with the tokens used, for cost tracking and evals.
  onUsage?: (usage: TokenUsage) => void;
};

// The tokens one model call used, for working out its cost.
export type TokenUsage = { model: string; inputTokens: number; outputTokens: number };

// The letter as a content block: a document block for a PDF, an image block
// for a photo. Throws on a file type the model can't read; the upload step
// should have rejected it already (checkLetterFile gives the customer message).
const letterContentBlock = (letterFile: Buffer): Anthropic.ContentBlockParam => {
  const fileCheck = checkLetterFile(letterFile);
  if (!fileCheck.isSupported) throw new Error(`Unsupported letter file: ${fileCheck.reason}`);
  const data = letterFile.toString("base64");
  return fileCheck.mediaType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: fileCheck.mediaType, data } };
};

// Builds a LetterExtractor that sends the letter (a PDF or a photo) to a
// Claude model and returns the model's reading, checked against the
// LetterExtraction schema. Throws on truncated, refused or off-schema output.
export const makeAnthropicExtractor =
  ({ client, model, maxTokens = 4096, onUsage }: AnthropicExtractorOptions): LetterExtractor =>
  async (letterFile) => {
    const response = await client.messages.parse({
      model,
      max_tokens: maxTokens,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [letterContentBlock(letterFile), { type: "text", text: "Extract the fields from this document." }],
        },
      ],
      output_config: { format: zodOutputFormat(LetterExtraction) },
    });

    onUsage?.({ model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens });

    // Truncated or refused output may not match the schema: never use it.
    if (response.stop_reason === "max_tokens") {
      throw new Error(`Extraction truncated at max_tokens (${maxTokens}) by ${model}`);
    }
    if (response.stop_reason === "refusal") {
      throw new Error(`Extraction refused by ${model}`);
    }
    if (response.parsed_output == null) {
      throw new Error(`Extraction from ${model} didn't match the schema`);
    }
    return response.parsed_output;
  };
