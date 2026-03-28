# Phase 1 Completion Design

**Date:** 2026-03-27
**Status:** Approved
**Issues:** #14 (blob storage), #15 (docker-compose), #16 (CAR import), #26 (deviation docs)

## #14 — Blob Storage

### Architecture

Dual-backend blob storage with a common interface. Storage backend selected via `BLOB_STORAGE` env var.

### Storage Interface

```typescript
interface BlobStore {
  put(cid: string, data: Buffer, mimeType: string): Promise<void>;
  get(cid: string): Promise<{ data: Buffer; mimeType: string } | null>;
  delete(cid: string): Promise<void>;
  exists(cid: string): Promise<boolean>;
}
```

Two implementations:
- **LocalBlobStore** (`BLOB_STORAGE=local`, default) — filesystem at `BLOB_STORAGE_PATH` (default `./data/blobs`), organized as `<first-2-chars-of-cid>/<cid>`
- **S3BlobStore** (`BLOB_STORAGE=s3`) — S3-compatible storage, key prefix `blobs/<first-2-chars-of-cid>/<cid>`

### S3 Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `BLOB_S3_BUCKET` | Yes (if s3) | Bucket name |
| `BLOB_S3_REGION` | No | Default `us-east-1` |
| `BLOB_S3_ENDPOINT` | No | Custom endpoint for Railway Object Storage, MinIO, R2 |
| `BLOB_S3_ACCESS_KEY_ID` | Yes (if s3) | AWS access key |
| `BLOB_S3_SECRET_ACCESS_KEY` | Yes (if s3) | AWS secret key |

### New Dependency

`@aws-sdk/client-s3` — modular S3 client (~300KB, no full AWS SDK)

### Upload Endpoint

```
POST /xrpc/com.atproto.repo.uploadBlob
Content-Type: image/jpeg (or image/png, image/webp, image/gif)
Body: raw binary data
Auth: Required (approved user)
```

**Flow:**
1. Validate Content-Type against allowlist: `image/jpeg`, `image/png`, `image/webp`, `image/gif`
2. Validate size <= `BLOB_MAX_SIZE` (default 1MB, env-configurable)
3. Compute CID from blob data using `@atproto/repo` utilities (SHA-256, raw codec)
4. Store blob via BlobStore interface
5. Insert metadata into `blobs` table
6. Return ATProto blob ref object

**Response:**
```json
{
  "blob": {
    "$type": "blob",
    "ref": { "$link": "bafkrei..." },
    "mimeType": "image/jpeg",
    "size": 45678
  }
}
```

### Serve Endpoint

```
GET /blob/:did/:cid
Auth: None (public)
```

Returns blob data with correct `Content-Type` header and `Cache-Control: public, max-age=31536000, immutable` (blobs are content-addressed — they never change).

### Database Table

```sql
CREATE TABLE IF NOT EXISTS blobs (
    cid TEXT PRIMARY KEY,
    did TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

### Profile Integration

Profile records (both `app.bsky.actor.profile` and custom collections) can include blob references:
```json
{
  "displayName": "Carlos",
  "description": "Goalkeeper",
  "avatar": {
    "$type": "blob",
    "ref": { "$link": "bafkrei..." },
    "mimeType": "image/jpeg",
    "size": 45678
  }
}
```

The `updateProfile` endpoint does not need changes — it already accepts arbitrary record objects. The blob ref is just data in the record.

### Files

| File | Responsibility |
|------|----------------|
| **Create:** `src/blob/blob-store.ts` | BlobStore interface + factory function |
| **Create:** `src/blob/local-store.ts` | LocalBlobStore implementation |
| **Create:** `src/blob/s3-store.ts` | S3BlobStore implementation |
| **Create:** `src/api/com.atproto.repo.uploadBlob.ts` | Upload endpoint |
| **Create:** `src/lexicon/com.atproto.repo.uploadBlob.json` | Lexicon |
| **Modify:** `src/server/index.ts` | Register uploadBlob handler + blob serve route |
| **Modify:** `src/config.ts` | Add blob config section |
| **Modify:** `src/db/schema.sql` | Add blobs table |
| **Create:** `scripts/migrate-007-blobs.sql` | Migration for existing deployments |

---

## #15 — Docker Compose

### Files

| File | Responsibility |
|------|----------------|
| **Create:** `Dockerfile` | Multi-stage build (builder + runtime) |
| **Create:** `docker-compose.yml` | postgres + pds services |
| **Create:** `.dockerignore` | Exclude node_modules, .env, etc. |

### Dockerfile

Multi-stage:
1. **Builder stage** (`node:22-alpine`): `npm ci`, `npm run build`
2. **Runtime stage** (`node:22-alpine`): copy `dist/`, `node_modules/`, `package.json`, `scripts/`

### docker-compose.yml

```yaml
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: openfederation
      POSTGRES_USER: openfederation
      POSTGRES_PASSWORD: ${DB_PASSWORD:-changeme}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U openfederation"]
      interval: 5s
      timeout: 3s
      retries: 5

  pds:
    build: .
    ports:
      - "${PDS_PORT:-8080}:8080"
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: openfederation
      DB_USER: openfederation
      DB_PASSWORD: ${DB_PASSWORD:-changeme}
      AUTH_JWT_SECRET: ${AUTH_JWT_SECRET}
      KEY_ENCRYPTION_SECRET: ${KEY_ENCRYPTION_SECRET}
      PDS_HOSTNAME: ${PDS_HOSTNAME:-localhost}
      PDS_SERVICE_URL: ${PDS_SERVICE_URL:-http://localhost:8080}
      BLOB_STORAGE: ${BLOB_STORAGE:-local}
      BLOB_STORAGE_PATH: /data/blobs
    volumes:
      - blobdata:/data/blobs
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/health"]
      interval: 10s
      timeout: 3s
      retries: 3

volumes:
  pgdata:
  blobdata:
```

---

## #16 — CAR Import

### Endpoint

```
POST /xrpc/net.openfederation.admin.importRepo
Auth: Admin only
Content-Type: application/vnd.ipld.car (or application/octet-stream)
Body: raw CAR stream
Query: ?did=did:plc:... (the DID to register the repo under)
```

### Flow

1. Admin auth check
2. Verify the DID doesn't already have a repo on this PDS
3. Parse CAR stream using `@atproto/repo` utilities
4. Extract all blocks and the root CID
5. Store blocks in `repo_blocks` table
6. Register root in `repo_roots` table
7. Walk the MST to populate `records_index` for fast queries
8. Return success with record count

**Does NOT verify commit signatures** — the importing admin is trusted. Cross-PDS signature verification is a Phase 3 concern.

### Files

| File | Responsibility |
|------|----------------|
| **Create:** `src/api/net.openfederation.admin.importRepo.ts` | Import handler |
| **Create:** `src/lexicon/net.openfederation.admin.importRepo.json` | Lexicon |
| **Modify:** `src/server/index.ts` | Register handler |

---

## #26 — Whitepaper Deviations

### File

| File | Responsibility |
|------|----------------|
| **Create:** `docs/whitepaper-deviations.md` | Documents deliberate deviations from whitepaper |

### Content

Two deviations:
1. **Attestation revocation:** delete-as-revoke instead of `revokedAt` field. Rationale: more ATProto-native, eliminates "forgot to check revoked field" bugs, signed deletion commit is cryptographic proof.
2. **Role model:** String roles instead of role-reference to `community.role` records. Rationale: simpler for Phase 1, custom roles tracked in #17 for Phase 2.
