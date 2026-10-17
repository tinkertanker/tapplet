import type { StudioEnv } from "../../env";
import type { ImageSafetyInspector, ImageSafetyReview } from "../../imageSafety";
import { IMAGE_SAFETY_QUESTION, imageDataUrl, parseImageSafetyAnswer } from "../../imageSafety";
import { readTkslopperConfig } from "./config";
import type { TkslopperClientConfig } from "./config";
import { TkslopperClient, TkslopperError } from "./client";
import type { TkslopperClientOptions, TkslopperGatewayResult } from "./client";
import { effortField, responsesOutcome } from "./outcome";
import { REVIEW_MAX_OUTPUT_TOKENS } from "./provider";
import type { TkslopperModelProviderOptions } from "./provider";

export class TkslopperImageSafetyInspector implements ImageSafetyInspector {
  private readonly client: TkslopperClient;

  constructor(
    private readonly config: TkslopperClientConfig,
    options: TkslopperModelProviderOptions = {},
  ) {
    this.client = options.client ?? new TkslopperClient(config, options);
  }

  async inspect(bytes: Uint8Array, mediaType: string): Promise<ImageSafetyReview> {
    let result: TkslopperGatewayResult;
    try {
      result = await this.client.request(
        "/v1/responses",
        {
          model: this.config.imageAlias,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: IMAGE_SAFETY_QUESTION },
                { type: "input_image", image_url: imageDataUrl(bytes, mediaType) },
              ],
            },
          ],
          max_output_tokens: REVIEW_MAX_OUTPUT_TOKENS,
          ...effortField("responses", this.config.imageEffort),
          stream: false,
        },
        "image_review",
      );
    } catch (error) {
      const requestId =
        error instanceof TkslopperError ? error.gatewayRequestId : undefined;
      const status = error instanceof TkslopperError ? error.status : undefined;
      console.error(
        `Image safety review failed${status === undefined ? "" : `: HTTP ${status}`}${requestId ? ` (request ${requestId})` : ""}`,
      );
      return { status: "unavailable" };
    }
    const requestSuffix = result.gatewayRequestId
      ? ` (request ${result.gatewayRequestId})`
      : "";
    const outcome = responsesOutcome(result.body);
    if (outcome.kind !== "complete") {
      console.error(`Image safety review was ${outcome.kind}${requestSuffix}`);
      return { status: "unavailable" };
    }
    const review = parseImageSafetyAnswer(outcome.text);
    if (review) return review;
    console.error(`Image safety review returned an invalid answer${requestSuffix}`);
    return { status: "unavailable" };
  }
}

export function createTkslopperImageSafetyInspector(
  env: StudioEnv,
  options: TkslopperClientOptions = {},
): ImageSafetyInspector {
  const result = readTkslopperConfig(env);
  if (result.ok) return new TkslopperImageSafetyInspector(result.config, options);
  const reason = result.reason;
  return {
    async inspect(): Promise<ImageSafetyReview> {
      console.error(`Image safety review unavailable: ${reason}`);
      return { status: "unavailable" };
    },
  };
}
