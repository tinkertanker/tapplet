import { describe, expect, it } from 'vitest';
import { inspectHtml, inspectText } from '../src/moderation';

describe('deterministic moderation', () => {
  it('handles long non-email runs without repeatedly scanning their suffixes', () => {
    const start = performance.now();
    expect(inspectText('a.'.repeat(40_000))).toEqual([]);
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it.each([
    ['Contact Teacher+class@example.school today', true],
    ['.teacher@example.school', true],
    ['a@b@school.example', true],
    ['a@b.c', false],
    ['---@school.example', false],
    ['a@school.example_undelimited', false],
    ['a@school.example.test', true],
  ])('keeps email advisory detection for %s', (text, expected) => {
    expect(inspectText(text).some((finding) => finding.code === 'POSSIBLE_EMAIL')).toBe(expected);
  });

  it('checks content displayed from inline JavaScript', () => {
    expect(inspectHtml('<script>const contact = "91234567";</script>'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'POSSIBLE_PHONE' }),
      ]));
  });

  it('does not treat numeric JavaScript constants as phone numbers', () => {
    expect(inspectHtml('<script>const millisecondsPerDay = 86400000;</script>'))
      .toEqual([]);
  });

  it('flags direct weapon-building instructions for advisory review', () => {
    expect(inspectText('How to make a bomb: combine these materials and follow these steps.'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'UNSAFE_HARM_INSTRUCTION' }),
      ]));
  });

  it('keeps age-appropriate historical discussion available', () => {
    expect(inspectText(
      'Compare the causes and civilian consequences of the Second World War using age-appropriate sources.',
    )).toEqual([]);
  });
});
