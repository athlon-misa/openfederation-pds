# Joining the AT Protocol network

An OpenFederation server speaks AT Protocol. For its accounts and communities to work in
**every** AT Protocol app (Bluesky's apps, other PDSes, bridges, and the fediverse sign-in in
[OIDC.md](OIDC.md) on other servers), two lookups have to succeed from anywhere:

1. **DID → document.** A `did:plc` is looked up in a PLC directory. Most of the network asks
   `plc.directory` only. A server that registers its DIDs in its own directory
   (`PLC_DIRECTORY_URL`, e.g. `plc.openfederation.net`) is invisible to them until those DIDs
   are also in `plc.directory`.
2. **Handle → DID.** `alice.openfederation.net` resolves through a DNS TXT record
   `_atproto.alice.openfederation.net` or `https://alice.openfederation.net/.well-known/atproto-did`.

This server itself reads both kinds: DIDs from every directory in `PLC_RESOLVER_URLS`
(default: its own, then `plc.directory`), and its own handles from its database.

## DIDs: mirror into plc.directory

`plc-server/mirror.js` copies this directory's operation logs into another directory.
One-way and append-only: for each DID it submits, in order, the operations the target is
missing; it never re-signs anything (the target verifies every operation against the DID's
rotation keys, exactly as this directory did); a DID whose history differs in the target
is reported and left alone.

```bash
# See what would be sent (sends nothing):
node plc-server/mirror.js --source https://plc.openfederation.net
node plc-server/mirror.js --source https://plc.openfederation.net --did did:plc:…

# Send:
node plc-server/mirror.js --source https://plc.openfederation.net --apply
```

To keep them in step, set on the PLC service (`openfederation-plc`):

| Variable | |
|---|---|
| `PLC_MIRROR_TARGETS` | Comma-separated directories to mirror into, e.g. `https://plc.directory`. Unset: off. Refused on a demo directory |
| `PLC_MIRROR_INTERVAL_SECONDS` | Default 60 |
| `PLC_MIRROR_SOURCE` | Default the service itself (`http://127.0.0.1:$PORT`) |

The first pass covers every DID, so turning it on also backfills.

**Before you turn it on:**

- It is **permanent and public**: plc.directory keeps every operation it accepts. That
  includes pen names' DIDs (which are public in this directory too) and DIDs nobody uses any
  more. A DID cannot be removed from either directory.
- This directory stays the one this server writes to. An operation someone submits only to
  plc.directory (e.g. a self-custody account moving away with its own tools) does not come
  back; later operations here then no longer fit plc.directory's history, the mirror reports
  the DID as diverged, and `PLC_RESOLVER_URLS` order decides which history this server reads.
- Alternatively, register new identities in plc.directory directly
  (`PLC_DIRECTORY_URL=https://plc.directory`) and mirror only the existing ones once.

## Handles: wildcard DNS

The PDS answers `/.well-known/atproto-did` for every name under its handle domain. What is
missing is DNS sending those names to it:

1. **Cloudflare** (DNS only, not proxied): `CNAME *.openfederation.net →` the PDS service's
   Railway target. Records that exist (`pds`, `plc`, `beta`, `www`, `mastodon`, …) keep
   winning over the wildcard.
2. **Railway**: add the custom domain `*.openfederation.net` to `openfederation-pds`
   (as the demo servers do for `*.demo.openfederation.net`), so it gets certificates for
   each name.

Then `https://ap-test.openfederation.net/.well-known/atproto-did` answers the DID.

## Check an identity

```bash
ofc identity check alice.openfederation.net
ofc identity check did:plc:…
```

Prints, for a handle or DID: the DNS TXT record, the HTTPS well-known answer, the document in
each PLC directory (this server's and plc.directory), whether the document's handle and PDS
match, and what is missing for the rest of the network.
