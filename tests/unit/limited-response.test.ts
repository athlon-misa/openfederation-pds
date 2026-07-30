import { describe, expect, it } from 'vitest';
import { readLimitedText } from '../../src/security/outbound-fetch.js';

describe('limited outbound response reader', () => {
  it('rejects a response before retaining more than its byte limit', async () => {
    const response = new Response('x'.repeat(33));
    await expect(readLimitedText(response, 32)).rejects.toThrow(/too large/i);
  });
});
