import { describe, expect, it, vi } from 'vitest';
import { OpenCodeGoImageSafetyInspector } from '../src/imageSafety';

describe('image safety review', () => {
  it.each(['network', 'http', 'empty', 'invalid'] as const)(
    'keeps pupil content out of %s diagnostics', async (path) => {
      const marker = 'SYNTHETIC_PUPIL_MARKER';
      const fetch = vi.fn();
      if (path === 'network') {
        const error = new Error(marker);
        error.name = marker;
        fetch.mockRejectedValue(error);
      } else {
        fetch.mockResolvedValue(Response.json({
          id: marker,
          error: { message: marker, code: marker },
          output: [{ content: [{
            type: path === 'empty' ? 'refusal' : 'output_text',
            text: marker,
          }] }],
        }, { status: path === 'http' ? 503 : 200 }));
      }
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(createInspector(fetch).inspect(new Uint8Array([1]), 'image/png'))
          .resolves.toEqual({ status: 'unavailable' });
        expect(log).toHaveBeenCalledOnce();
        expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
        expect(log.mock.calls[0]).toEqual([{
          network: 'Image safety review failed: network',
          http: 'Image safety review failed: HTTP 503',
          empty: 'Image safety review returned no answer',
          invalid: 'Image safety review returned an invalid answer',
        }[path]]);
      } finally {
        log.mockRestore();
      }
    },
  );

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
