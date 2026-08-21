import { describe, expect, it, vi } from 'vitest';
import { OpenCodeGoImageSafetyInspector } from '../src/imageSafety';

describe('image safety review', () => {
  it('accepts an explicitly safe classroom image classification', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({
      output: [{ content: [{ type: 'output_text', text: 'SAFE\nA labelled force diagram.' }] }],
    }));
    const inspector = createInspector(fetch);

    await expect(inspector.inspect(new Uint8Array([1, 2, 3]), 'image/png')).resolves.toEqual({
      status: 'clear',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://opencode.ai/zen/go/v1/responses',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer secret',
        }),
      }),
    );
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as {
      model: string;
      reasoning: { effort: string };
      input: { content: { type: string; image_url?: string }[] }[];
    };
    expect(body.model).toBe('gpt-5.6-luna');
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body.input[0]?.content[1]?.image_url).toBe('data:image/png;base64,AQID');
  });

  it('returns advisory findings for flagged pixels and review outages', async () => {
    const flagged = createInspector(vi.fn().mockResolvedValue(Response.json({
      output: [{ content: [{ type: 'output_text', text: 'UNSAFE\nA pupil face is visible.' }] }],
    })));
    await expect(flagged.inspect(new Uint8Array([1]), 'image/jpeg')).resolves.toEqual({
      status: 'flagged',
      reason: 'A pupil face is visible.',
    });

    const unavailable = createInspector(vi.fn().mockRejectedValue(new Error('offline')));
    await expect(unavailable.inspect(new Uint8Array([1]), 'image/jpeg')).resolves.toEqual({
      status: 'unavailable',
    });

    const malformed = createInspector(vi.fn().mockResolvedValue(Response.json({
      output: [{ content: [{ type: 'output_text', text: 'maybe' }] }],
    })));
    await expect(malformed.inspect(new Uint8Array([1]), 'image/jpeg')).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('combines split Responses API output text', async () => {
    const inspector = createInspector(vi.fn().mockResolvedValue(Response.json({
      output: [
        { content: [{ type: 'output_text', text: 'UN' }] },
        { content: [{ type: 'output_text', text: 'SAFE\nA face is visible.' }] },
      ],
    })));

    await expect(inspector.inspect(new Uint8Array([1]), 'image/jpeg')).resolves.toEqual({
      status: 'flagged',
      reason: 'A face is visible.',
    });
  });
});

function createInspector(fetch: typeof globalThis.fetch) {
  return new OpenCodeGoImageSafetyInspector({
    apiKey: 'secret',
    model: 'gpt-5.6-luna',
    fetch,
  });
}
