export interface ImageSafetyInspector {
  inspect(bytes: Uint8Array, mediaType: string): Promise<ImageSafetyReview>;
}

export type ImageSafetyReview =
  | { status: 'clear' }
  | { status: 'flagged'; reason?: string }
  | { status: 'unavailable' };

interface OpenCodeGoImageSafetyInspectorOptions {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}

const QUESTION = `Classify this teacher-uploaded classroom image.
Reply on the first line with exactly SAFE or UNSAFE, then one short reason.
Mark UNSAFE if it contains any visible person or face, nudity or sexual content, graphic injury,
weapons or illegal drugs, hateful symbols, or visible personal information such as a pupil name,
email address, phone number, identity number or class list.
Ordinary diagrams, worksheets, teacher sketches and logos are SAFE when none of those are present.`;

export class OpenCodeGoImageSafetyInspector implements ImageSafetyInspector {
  private readonly request: typeof fetch;

  constructor(private readonly options: OpenCodeGoImageSafetyInspectorOptions) {
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async inspect(bytes: Uint8Array, mediaType: string): Promise<ImageSafetyReview> {
    let response: Response;
    try {
      response = await this.request('https://opencode.ai/zen/go/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.model,
          input: [{
            role: 'user',
            content: [
              { type: 'input_text', text: QUESTION },
              {
                type: 'input_image',
                image_url: `data:${mediaType};base64,${base64(bytes)}`,
              },
            ],
          }],
          reasoning: { effort: 'none' },
          max_output_tokens: 500,
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      const diagnostic = error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
      console.error(`Image safety review failed: ${diagnostic}`);
      return { status: 'unavailable' };
    }

    const result = await response.json().catch(() => null) as {
      output?: { content?: { type?: string; text?: string }[] }[];
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      console.error(
        `Image safety review failed: ${result?.error?.message ?? `HTTP ${response.status}`}`,
      );
      return { status: 'unavailable' };
    }
    const answer = result?.output
      ?.flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text' && item.text)
      .map((item) => item.text)
      .join('')
      .trim();
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
