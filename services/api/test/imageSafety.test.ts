import { describe, expect, it, vi } from 'vitest';
import { CloudflareImageSafetyInspector } from '../src/imageSafety';

describe('image safety review', () => {
  it('accepts an explicitly safe classroom image classification', async () => {
    const run = vi.fn().mockResolvedValue({
      result: { answer: 'SAFE\nA labelled force diagram.' },
      usage: { total_tokens: 42 },
    });
    const inspector = new CloudflareImageSafetyInspector({ run });

    await expect(inspector.inspect(new Uint8Array([1, 2, 3]), 'image/png')).resolves.toEqual({
      status: 'clear',
    });
    expect(run).toHaveBeenCalledWith(
      '@cf/moondream/moondream3.1-9B-A2B',
      expect.objectContaining({ task: 'query', stream: false, reasoning: false }),
    );
  });

  it('returns advisory findings for flagged pixels and review outages', async () => {
    const flagged = new CloudflareImageSafetyInspector({
      run: vi.fn().mockResolvedValue({ answer: 'UNSAFE\nA pupil face is visible.' }),
    });
    await expect(flagged.inspect(new Uint8Array([1]), 'image/jpeg')).resolves.toEqual({
      status: 'flagged',
      reason: 'A pupil face is visible.',
    });

    const unavailable = new CloudflareImageSafetyInspector({
      run: vi.fn().mockRejectedValue(new Error('offline')),
    });
    await expect(unavailable.inspect(new Uint8Array([1]), 'image/jpeg')).resolves.toEqual({
      status: 'unavailable',
    });

    const malformed = new CloudflareImageSafetyInspector({
      run: vi.fn().mockResolvedValue({ answer: 'maybe' }),
    });
    await expect(malformed.inspect(new Uint8Array([1]), 'image/jpeg')).resolves.toEqual({
      status: 'unavailable',
    });
  });
});
