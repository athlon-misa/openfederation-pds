# OpenFederation Matrix Bridge

Syncs community membership and roles from an OpenFederation PDS to Matrix Spaces.

## Features

- One-way sync: PDS to Matrix (PDS is source of truth)
- Space membership: invites/kicks members based on PDS community membership
- Power levels: maps PDS roles to Matrix power levels
- Three modes: public Matrix, self-hosted, partner-hosted

## Quick Start

1. `npm install`
2. Copy `config.example.json` to `config.json` and fill in values
3. `npm run dev` (development) or `npm run build && npm start` (production)

## Modes

### Public (`mode: "public"`)
Users link Matrix IDs via their PDS profile. Set custom profile collection `app.matrix.actor.profile` with `{ matrixId: "@user:matrix.org" }`.

### Self-hosted (`mode: "self-hosted"`)
Bridge auto-provisions Matrix accounts from PDS handles using the admin API. Configure `handleTemplate` (e.g., `{handle}:club.hackney.org`).

### Partner-hosted (`mode: "partner-hosted"`)
Like self-hosted, but operated by a partner (e.g., Grvty) for multiple communities. Shared homeserver or dedicated per-community.

## Role Power Levels

Map PDS community roles to Matrix power levels:
```json
{
  "rolePowerLevels": {
    "owner": 100,
    "moderator": 50,
    "coach": 25,
    "member": 0
  }
}
```
