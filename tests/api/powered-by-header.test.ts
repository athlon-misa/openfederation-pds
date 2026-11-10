import { describe, it, expect } from 'vitest';
import { api } from './helpers.js';

describe('response headers', () => {
  it('do not advertise the framework', async () => {
    const res = await api.get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
