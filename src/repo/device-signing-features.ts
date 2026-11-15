/**
 * What works while device signing is on (#240), as this server reports it
 * (net.openfederation.account.getDeviceSigning → features). Clients show it
 * instead of keeping their own list, so a screen never promises a feature
 * this server cannot do for a device-signing account, or hides one it can.
 *
 * `available: true` means the feature works with device signing on: the
 * device signs the change (prepareCommit / submitCommit for record writes,
 * prepareAction / submitCommit for the features that write on the person's
 * behalf, phase 2) or signs the token itself, so an app that signs on the
 * device can use it. `false`: it refuses with DeviceSigningRequired (or
 * leaves the signed part out) while device signing is on, because the server
 * would have to sign as the person.
 */
export interface DeviceSigningFeature {
  id: string;
  /** Plain words, as the dashboard shows them. */
  title: string;
  available: boolean;
}

export const DEVICE_SIGNING_FEATURES: readonly DeviceSigningFeature[] = [
  { id: 'repo.write', title: 'Posts and other records written by an app that signs on your device', available: true },
  { id: 'profile', title: 'Changing your profile, signed on your device', available: true },
  { id: 'contacts', title: 'Adding, accepting, removing and blocking contacts, signed on your device', available: true },
  { id: 'membership', title: 'Membership records of the communities you join, written in your own repository by your device', available: true },
  { id: 'governance', title: 'Voting on and objecting to community proposals, signed on your device', available: true },
  { id: 'forum', title: 'Starting forum threads and posting replies, signed on your device (in a private community, signed as yours and kept in its repository)', available: true },
  { id: 'calendar.rsvp', title: 'Answering event invitations (RSVP), signed on your device', available: true },
  { id: 'serviceAuth', title: 'Signing in to other servers and services with your account (your device signs the token)', available: true },
  { id: 'signIn.wallet', title: 'Signing in to apps with your wallet (Sign in with OpenFederation; your device signs the token)', available: true },
  { id: 'delegatedVotes', title: 'Votes a delegate casts for you: only your device can sign your vote, so they are not counted for you', available: false },
  { id: 'externalKeys', title: 'Linking keys from other networks (wallets and other identities)', available: false },
  { id: 'walletProof', title: 'A signed proof of your main wallet for people who look it up (the wallet is still shown, without the proof)', available: false },
  { id: 'remoteActivity', title: 'Activity from your communities on other servers in your timeline (this server would have to ask them as you)', available: false },
];

export function deviceSigningFeatures(): DeviceSigningFeature[] {
  return DEVICE_SIGNING_FEATURES.map((f) => ({ ...f }));
}
