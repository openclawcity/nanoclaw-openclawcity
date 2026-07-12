import { describe, it, expect } from 'vitest';
// The sanitize helper lives in src/sanitize.ts in this package (it is also
// re-exported from src/index.ts via the barrel).
import { sanitizeReplyText } from '../sanitize.js';

describe('sanitizeReplyText', () => {
  // ── Clean text passes through unchanged ──

  it('returns clean text as-is', () => {
    expect(sanitizeReplyText('Hello, how are you?')).toBe('Hello, how are you?');
  });

  it('preserves markdown formatting', () => {
    const md = '**Bold** and _italic_ and `code`';
    expect(sanitizeReplyText(md)).toBe(md);
  });

  it('preserves multi-line text', () => {
    const text = 'Line 1\nLine 2\nLine 3';
    expect(sanitizeReplyText(text)).toBe(text);
  });

  it('preserves legitimate angle brackets in text', () => {
    expect(sanitizeReplyText('Use <div> tags for layout')).toBe('Use <div> tags for layout');
  });

  it('preserves text with numbers that look like PLHD but are not', () => {
    expect(sanitizeReplyText('See section <PLH> for details')).toBe('See section <PLH> for details');
  });

  // ── PLHD tool-call markup stripping ──

  it('strips simple <PLHD>...<PLHD> markup', () => {
    const leaked = '<PLHD>[{"name":"read","parameters":{"path":"/home/user/file.md"}}]<PLHD>';
    expect(sanitizeReplyText(leaked)).toBeNull();
  });

  it('strips numbered <PLHD20>...<PLHD21> markup', () => {
    const leaked =
      '<PLHD20>[{"name":"read","parameters":{"path":"/home/vincent/.openclaw/workspace/HEARTBEAT.md"}}]<PLHD21>';
    expect(sanitizeReplyText(leaked)).toBeNull();
  });

  it('strips PLHD markup while preserving surrounding text', () => {
    const text =
      'Let me check that for you. <PLHD>[{"name":"read","parameters":{"path":"/tmp/file"}}]<PLHD> I will look into it.';
    expect(sanitizeReplyText(text)).toBe('Let me check that for you.  I will look into it.');
  });

  it('strips multiple PLHD blocks', () => {
    const text =
      '<PLHD1>[{"name":"read","parameters":{}}]<PLHD2> some text <PLHD3>[{"name":"write","parameters":{}}]<PLHD4>';
    expect(sanitizeReplyText(text)).toBe('some text');
  });

  it('strips PLHD markup with multiline JSON content', () => {
    const leaked =
      '<PLHD>[\n  {\n    "name": "read",\n    "parameters": {\n      "path": "/tmp/file"\n    }\n  }\n]<PLHD>';
    expect(sanitizeReplyText(leaked)).toBeNull();
  });

  // ── Empty / whitespace handling ──

  it('returns null for empty string', () => {
    expect(sanitizeReplyText('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(sanitizeReplyText('   \n  \t  ')).toBeNull();
  });

  it('returns null when PLHD stripping leaves only whitespace', () => {
    expect(sanitizeReplyText('  <PLHD>[{"name":"x"}]<PLHD>  ')).toBeNull();
  });

  // ── Edge cases ──

  it('handles text with only opening PLHD tag (no match, preserved)', () => {
    expect(sanitizeReplyText('text <PLHD> more text')).toBe('text <PLHD> more text');
  });

  it('handles very long clean text', () => {
    const long = 'A'.repeat(10000);
    expect(sanitizeReplyText(long)).toBe(long);
  });

  it('trims leading/trailing whitespace from result', () => {
    expect(sanitizeReplyText('  hello world  ')).toBe('hello world');
  });
});

describe('runtime error banners are never a reply', () => {
  it('drops context-overflow banners instead of shipping them to the city', () => {
    expect(
      sanitizeReplyText('⚠️ Context is too large and auto-compaction could not recover this turn. Try again.'),
    ).toBeNull();
    expect(sanitizeReplyText('Context is too large and auto-compaction could not recover this turn.')).toBeNull();
  });
  it('keeps normal replies intact', () => {
    expect(sanitizeReplyText('The context of our poem: wings carry words.')).toBe(
      'The context of our poem: wings carry words.',
    );
  });
});
