import { describe, it, expect } from 'vitest';

describe('membership module decomposition (issue #62)', () => {
  it('join lifecycle lives in its own module', async () => {
    const mod = await import('../../src/community/membership/join.js');
    expect(typeof mod.joinCommunityLifecycle).toBe('function');
  });

  it('leave lifecycle lives in its own module', async () => {
    const mod = await import('../../src/community/membership/leave.js');
    expect(typeof mod.leaveCommunityLifecycle).toBe('function');
  });

  it('remove lifecycle lives in its own module', async () => {
    const mod = await import('../../src/community/membership/remove.js');
    expect(typeof mod.removeMemberLifecycle).toBe('function');
  });

  it('resolve-join-request lifecycle lives in its own module', async () => {
    const mod = await import('../../src/community/membership/resolve.js');
    expect(typeof mod.resolveJoinRequestLifecycle).toBe('function');
  });

  it('update lifecycle lives in its own module', async () => {
    const mod = await import('../../src/community/membership/update.js');
    expect(typeof mod.updateMemberLifecycle).toBe('function');
  });
});
