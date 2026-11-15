/**
 * What works while device signing is on (#240), as this server reports it
 * (net.openfederation.account.getDeviceSigning → features). Clients show it
 * instead of keeping their own list, so a screen never promises a feature
 * this server cannot do for a device-signing account, or hides one it can.
 *
 * `available: true` means the feature works with device signing on: the
 * device signs the change (prepareCommit / submitCommit) or the feature does
 * not need the repo key. `false`: it refuses with DeviceSigningRequired while
 * device signing is on.
 *
 * When a feature moves to device signing (phase 2 of #240), flip it here.
 */
export interface DeviceSigningFeature {
  id: string;
  /** Plain words, as the dashboard shows them. */
  title: string;
  available: boolean;
}

export const DEVICE_SIGNING_FEATURES: readonly DeviceSigningFeature[] = [
  { id: 'repo.write', title: 'Posts and other records written by an app that signs on your device', available: true },
  { id: 'profile', title: 'Changing your profile', available: false },
  { id: 'externalKeys', title: 'Linking keys from other networks (wallets and other identities)', available: false },
  { id: 'contacts', title: 'Adding and accepting contacts', available: false },
  { id: 'membership', title: 'Membership records of the communities you join, in your own repository', available: false },
  { id: 'governance', title: 'Voting on and objecting to community proposals', available: false },
  { id: 'forum', title: 'Starting forum threads and posting replies', available: false },
  { id: 'calendar.rsvp', title: 'Answering event invitations (RSVP)', available: false },
  { id: 'serviceAuth', title: 'Signing in to other apps and servers with your account', available: false },
];

export function deviceSigningFeatures(): DeviceSigningFeature[] {
  return DEVICE_SIGNING_FEATURES.map((f) => ({ ...f }));
}
