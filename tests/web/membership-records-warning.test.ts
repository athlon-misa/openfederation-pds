import { describe, expect, it } from 'vitest';
import {
  PRIVATE_SWITCH_WARNING, membershipRecordsNotice,
} from '../../web-interface/src/lib/membership-records';

describe('making a community private: membership records (#385)', () => {
  it('warns before saving that records on other servers cannot be removed', () => {
    expect(PRIVATE_SWITCH_WARNING).toMatch(/other servers/);
    expect(PRIVATE_SWITCH_WARNING).toMatch(/cannot remove/);
  });

  it('says nothing more when every record was removed', () => {
    expect(membershipRecordsNotice(undefined)).toBeNull();
    expect(membershipRecordsNotice({ removed: 3, keptOnDevice: 0, elsewhere: 0 })).toBeNull();
  });

  it('names what is left after saving', () => {
    expect(membershipRecordsNotice({ removed: 2, keptOnDevice: 0, elsewhere: 1 }))
      .toBe('1 member has an account on another server. Their public record of belonging to this community stays until they delete it.');
    expect(membershipRecordsNotice({ removed: 0, keptOnDevice: 2, elsewhere: 3 }))
      .toBe('3 members have accounts on other servers. Their public record of belonging to this community stays until they delete it. '
        + '2 members sign their records on their own device; only they can remove theirs.');
    expect(membershipRecordsNotice({ removed: 0, keptOnDevice: 1, elsewhere: 0 }))
      .toBe('1 member signs their records on their own device; only they can remove theirs.');
  });
});
