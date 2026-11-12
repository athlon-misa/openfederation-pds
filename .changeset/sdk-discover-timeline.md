---
"@open-federation/sdk": minor
---

`discoverCommunities({ limit, cursor, q })` lists public communities on the PDS and its peers (`net.openfederation.community.discover`), each with `pdsUrl`, `source` and, when the hosting server publishes one, `webUrl` (its dashboard origin), plus `peers` saying which peers answered; no sign-in needed. `getUserTimeline({ limit, cursor })` returns the signed-in user's activity across their communities (`net.openfederation.activity.getUserTimeline`): `entries`, `cursor`, `unreachable` and `unreachablePeers`. Types `DiscoverCommunitiesOptions`, `DiscoverCommunitiesResult`, `DiscoveredCommunity`, `DiscoveryPeerStatus`, `UserTimelineOptions`, `UserTimeline`, `ActivityEntry` and `ActivitySummary` are exported.
