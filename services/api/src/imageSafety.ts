export interface ImageSafetyInspector {
  inspect(bytes: Uint8Array, mediaType: string): Promise<ImageSafetyReview>;
}

export type ImageSafetyReview =
  | { status: 'clear' }
  | { status: 'flagged'; reason?: string }
  | { status: 'unavailable' };

interface WorkersAIImageBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

interface VisionAnswer {
  answer?: string;
}

interface WorkersAIEnvelope {
  result?: VisionAnswer;
}

const MODEL = '@cf/moondream/moondream3.1-9B-A2B';
const QUESTION = `Classify this teacher-uploaded classroom image.
Reply on the first line with exactly SAFE or UNSAFE, then one short reason.
Mark UNSAFE if it contains any visible person or face, nudity or sexual content, graphic injury,
weapons or illegal drugs, hateful symbols, or visible personal information such as a pupil name,
email address, phone number, identity number or class list.
Ordinary diagrams, worksheets, teacher sketches and logos are SAFE when none of those are present.`;

export class CloudflareImageSafetyInspector implements ImageSafetyInspector {
  constructor(private readonly ai: WorkersAIImageBinding) {}

  async inspect(bytes: Uint8Array, mediaType: string): Promise<ImageSafetyReview> {
    let result: unknown;
    try {
      result = await this.ai.run(MODEL, {
        task: 'query',
        image: `data:${mediaType};base64,${base64(bytes)}`,
        question: QUESTION,
        reasoning: false,
        temperature: 0,
        max_tokens: 80,
        stream: false,
      });
    } catch (error) {
      const diagnostic = error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
      console.error(`Image safety review failed: ${diagnostic}`);
      return { status: 'unavailable' };
    }

    const answer = result !== null && typeof result === 'object'
      ? (
          (result as VisionAnswer).answer ??
          (result as WorkersAIEnvelope).result?.answer
        )?.trim()
      : undefined;
    if (!answer) {
      console.error(`Image safety review returned no answer: ${serialiseDiagnostic(result)}`);
      return { status: 'unavailable' };
    }
    if (/^SAFE\b/i.test(answer)) return { status: 'clear' };
    if (/^UNSAFE\b/i.test(answer)) {
      const reason = answer
        .replace(/^UNSAFE\b[\s:.-]*/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
      return { status: 'flagged', ...(reason ? { reason } : {}) };
    }
    console.error(`Image safety review returned an invalid answer: ${serialiseDiagnostic(result)}`);
    return { status: 'unavailable' };
  }
}

function serialiseDiagnostic(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 1_000) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
