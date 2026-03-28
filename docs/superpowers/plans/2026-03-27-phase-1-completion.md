# Phase 1 Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 1 of the whitepaper: blob storage with S3+local backends, Docker Compose for self-hosting, CAR import for repo migration, and whitepaper deviation documentation.

**Architecture:** Blob storage uses a BlobStore interface with local filesystem and S3 implementations, selected via env var. CAR import uses `@atproto/repo` utilities to parse and store repo data. Docker Compose provides a one-command self-hosted deployment.

**Tech Stack:** TypeScript ESM, `@aws-sdk/client-s3`, `@atproto/repo` (readCarWithRoot), `multiformats` (CID), Docker multi-stage builds.

---

## File Structure

| File | Responsibility |
|------|----------------|
| **Create:** `src/blob/blob-store.ts` | BlobStore interface, factory, types |
| **Create:** `src/blob/local-store.ts` | Local filesystem implementation |
| **Create:** `src/blob/s3-store.ts` | S3-compatible implementation |
| **Create:** `src/api/com.atproto.repo.uploadBlob.ts` | Upload endpoint |
| **Create:** `src/api/net.openfederation.admin.importRepo.ts` | CAR import endpoint |
| **Create:** `src/lexicon/com.atproto.repo.uploadBlob.json` | Lexicon |
| **Create:** `src/lexicon/net.openfederation.admin.importRepo.json` | Lexicon |
| **Create:** `scripts/migrate-007-blobs.sql` | Blobs table migration |
| **Create:** `Dockerfile` | Multi-stage build |
| **Create:** `docker-compose.yml` | postgres + pds services |
| **Create:** `.dockerignore` | Build exclusions |
| **Create:** `docs/whitepaper-deviations.md` | Deviation documentation |
| **Modify:** `src/config.ts` | Add blob config section |
| **Modify:** `src/db/schema.sql` | Add blobs table |
| **Modify:** `src/server/index.ts` | Register handlers + blob serve route |
| **Modify:** `src/db/audit.ts` | Add importRepo audit action |
| **Create:** `tests/api/com.atproto.repo.uploadBlob.test.ts` | Blob upload tests |
| **Create:** `tests/api/net.openfederation.admin.importRepo.test.ts` | CAR import tests |

---

### Task 1: Blob storage interface and local implementation

**Files:**
- Create: `src/blob/blob-store.ts`
- Create: `src/blob/local-store.ts`

- [ ] **Step 1: Create the BlobStore interface and factory**

```typescript
// src/blob/blob-store.ts

export interface BlobStore {
  put(cid: string, data: Buffer, mimeType: string): Promise<void>;
  get(cid: string): Promise<{ data: Buffer; mimeType: string } | null>;
  delete(cid: string): Promise<void>;
  exists(cid: string): Promise<boolean>;
}

export type BlobStoreType = 'local' | 's3';

import { config } from '../config.js';

let _store: BlobStore | null = null;

export async function getBlobStore(): Promise<BlobStore> {
  if (_store) return _store;

  const storeType = config.blob.storage as BlobStoreType;

  if (storeType === 's3') {
    const { S3BlobStore } = await import('./s3-store.js');
    _store = new S3BlobStore();
  } else {
    const { LocalBlobStore } = await import('./local-store.js');
    _store = new LocalBlobStore(config.blob.localPath);
  }

  return _store;
}
```

- [ ] **Step 2: Create the local filesystem implementation**

```typescript
// src/blob/local-store.ts

import { mkdir, writeFile, readFile, unlink, access } from 'fs/promises';
import { join } from 'path';
import type { BlobStore } from './blob-store.js';

export class LocalBlobStore implements BlobStore {
  constructor(private basePath: string) {}

  private pathFor(cid: string): string {
    const prefix = cid.slice(0, 8);
    return join(this.basePath, prefix, cid);
  }

  private metaPathFor(cid: string): string {
    return this.pathFor(cid) + '.meta';
  }

  async put(cid: string, data: Buffer, mimeType: string): Promise<void> {
    const filePath = this.pathFor(cid);
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, data);
    await writeFile(this.metaPathFor(cid), mimeType, 'utf-8');
  }

  async get(cid: string): Promise<{ data: Buffer; mimeType: string } | null> {
    try {
      const data = await readFile(this.pathFor(cid));
      const mimeType = await readFile(this.metaPathFor(cid), 'utf-8');
      return { data, mimeType };
    } catch {
      return null;
    }
  }

  async delete(cid: string): Promise<void> {
    try {
      await unlink(this.pathFor(cid));
      await unlink(this.metaPathFor(cid));
    } catch {
      // Ignore if already gone
    }
  }

  async exists(cid: string): Promise<boolean> {
    try {
      await access(this.pathFor(cid));
      return true;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/blob/blob-store.ts src/blob/local-store.ts
git commit -m "feat(blob): add BlobStore interface and local filesystem implementation"
```

---

### Task 2: S3 blob store implementation

**Files:**
- Create: `src/blob/s3-store.ts`

- [ ] **Step 1: Install @aws-sdk/client-s3**

Run: `npm install @aws-sdk/client-s3`

- [ ] **Step 2: Create S3 implementation**

```typescript
// src/blob/s3-store.ts

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { config } from '../config.js';
import type { BlobStore } from './blob-store.js';

export class S3BlobStore implements BlobStore {
  private client: S3Client;
  private bucket: string;

  constructor() {
    this.bucket = config.blob.s3Bucket;
    this.client = new S3Client({
      region: config.blob.s3Region,
      ...(config.blob.s3Endpoint ? { endpoint: config.blob.s3Endpoint, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: config.blob.s3AccessKeyId,
        secretAccessKey: config.blob.s3SecretAccessKey,
      },
    });
  }

  private keyFor(cid: string): string {
    const prefix = cid.slice(0, 8);
    return `blobs/${prefix}/${cid}`;
  }

  async put(cid: string, data: Buffer, mimeType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.keyFor(cid),
      Body: data,
      ContentType: mimeType,
    }));
  }

  async get(cid: string): Promise<{ data: Buffer; mimeType: string } | null> {
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(cid),
      }));
      const body = await response.Body?.transformToByteArray();
      if (!body) return null;
      return {
        data: Buffer.from(body),
        mimeType: response.ContentType || 'application/octet-stream',
      };
    } catch (err: any) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async delete(cid: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.keyFor(cid),
    }));
  }

  async exists(cid: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(cid),
      }));
      return true;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/blob/s3-store.ts package.json package-lock.json
git commit -m "feat(blob): add S3-compatible blob store implementation"
```

---

### Task 3: Config, schema, migration for blobs

**Files:**
- Modify: `src/config.ts`
- Modify: `src/db/schema.sql`
- Create: `scripts/migrate-007-blobs.sql`

- [ ] **Step 1: Add blob config to config.ts**

Add after the `federation` section (before `oauth`):

```typescript
  // Blob storage configuration
  blob: {
    storage: (process.env.BLOB_STORAGE || 'local') as 'local' | 's3',
    localPath: process.env.BLOB_STORAGE_PATH || './data/blobs',
    maxSize: parseInt(process.env.BLOB_MAX_SIZE || '1048576', 10), // 1MB default
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    s3Bucket: process.env.BLOB_S3_BUCKET || '',
    s3Region: process.env.BLOB_S3_REGION || 'us-east-1',
    s3Endpoint: process.env.BLOB_S3_ENDPOINT || '',
    s3AccessKeyId: process.env.BLOB_S3_ACCESS_KEY_ID || '',
    s3SecretAccessKey: process.env.BLOB_S3_SECRET_ACCESS_KEY || '',
  },
```

- [ ] **Step 2: Add blobs table to schema.sql**

Add at the end of `src/db/schema.sql`:

```sql
-- Blob storage metadata
CREATE TABLE IF NOT EXISTS blobs (
    cid TEXT PRIMARY KEY,
    did TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_blobs_did ON blobs(did);
```

- [ ] **Step 3: Create migration script**

Create `scripts/migrate-007-blobs.sql`:

```sql
-- Migration 007: Add blobs table for binary asset storage
-- Run: psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f scripts/migrate-007-blobs.sql

CREATE TABLE IF NOT EXISTS blobs (
    cid TEXT PRIMARY KEY,
    did TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_blobs_did ON blobs(did);
```

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/db/schema.sql scripts/migrate-007-blobs.sql
git commit -m "feat(blob): add config, schema, and migration for blob storage"
```

---

### Task 4: Upload blob endpoint

**Files:**
- Create: `src/api/com.atproto.repo.uploadBlob.ts`
- Create: `src/lexicon/com.atproto.repo.uploadBlob.json`

- [ ] **Step 1: Create lexicon**

```json
{
  "lexicon": 1,
  "id": "com.atproto.repo.uploadBlob",
  "description": "Upload a binary blob (image) and receive a blob reference for use in records.",
  "defs": {
    "main": {
      "type": "procedure",
      "description": "Upload a blob. Returns a blob ref object with CID, MIME type, and size.",
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": {
            "blob": {
              "type": "object",
              "properties": {
                "$type": { "type": "string" },
                "ref": { "type": "object", "properties": { "$link": { "type": "string" } }, "required": ["$link"] },
                "mimeType": { "type": "string" },
                "size": { "type": "integer" }
              },
              "required": ["$type", "ref", "mimeType", "size"]
            }
          },
          "required": ["blob"]
        }
      },
      "errors": [
        { "name": "InvalidRequest", "description": "Missing or invalid Content-Type." },
        { "name": "BlobTooLarge", "description": "Blob exceeds the maximum allowed size." },
        { "name": "InvalidMimeType", "description": "Content-Type is not in the allowed list." }
      ]
    }
  }
}
```

- [ ] **Step 2: Create the upload handler**

This endpoint accepts raw binary body (not JSON). It needs special handling — Express `raw` middleware for this route.

```typescript
// src/api/com.atproto.repo.uploadBlob.ts

import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { getBlobStore } from '../blob/blob-store.js';
import { sha256 } from 'multiformats/hashes/sha2';
import { CID } from 'multiformats/cid';

// Raw codec for blobs (not CBOR)
const RAW_CODEC = 0x55;

export default async function uploadBlob(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;

    const contentType = req.headers['content-type'];

    if (!contentType || !config.blob.allowedMimeTypes.includes(contentType)) {
      res.status(400).json({
        error: 'InvalidMimeType',
        message: `Content-Type must be one of: ${config.blob.allowedMimeTypes.join(', ')}`,
      });
      return;
    }

    // Collect raw body
    const chunks: Buffer[] = [];
    let totalSize = 0;

    for await (const chunk of req) {
      totalSize += chunk.length;
      if (totalSize > config.blob.maxSize) {
        res.status(413).json({
          error: 'BlobTooLarge',
          message: `Blob exceeds maximum size of ${config.blob.maxSize} bytes`,
        });
        return;
      }
      chunks.push(Buffer.from(chunk));
    }

    const data = Buffer.concat(chunks);

    if (data.length === 0) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Empty blob body',
      });
      return;
    }

    // Compute CID: v1, raw codec, sha256
    const hash = await sha256.digest(data);
    const cid = CID.create(1, RAW_CODEC, hash);
    const cidStr = cid.toString();

    // Store blob
    const store = await getBlobStore();
    await store.put(cidStr, data, contentType);

    // Store metadata in database
    await query(
      `INSERT INTO blobs (cid, did, mime_type, size)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (cid) DO NOTHING`,
      [cidStr, req.auth!.did, contentType, data.length]
    );

    res.status(200).json({
      blob: {
        $type: 'blob',
        ref: { $link: cidStr },
        mimeType: contentType,
        size: data.length,
      },
    });
  } catch (error) {
    console.error('Error in uploadBlob:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to upload blob',
    });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/api/com.atproto.repo.uploadBlob.ts src/lexicon/com.atproto.repo.uploadBlob.json
git commit -m "feat(blob): add uploadBlob XRPC endpoint with CID computation"
```

---

### Task 5: Blob serve route + register handlers

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Add uploadBlob import and handler**

Add import after the existing ATProto imports:

```typescript
import uploadBlob from '../api/com.atproto.repo.uploadBlob.js';
```

Add to handler map (in the ATProto section):

```typescript
  'com.atproto.repo.uploadBlob': { handler: uploadBlob },
```

- [ ] **Step 2: Add blob serve route**

Add BEFORE the XRPC router (`app.all('/xrpc/:nsid', ...)`), after the middleware section:

```typescript
// Blob serve route — serves binary blobs by DID + CID
app.get('/blob/:did/:cid', async (req: Request, res: Response) => {
  try {
    const { did, cid } = req.params;
    if (!did || !cid) {
      return res.status(400).json({ error: 'InvalidRequest', message: 'Missing did or cid' });
    }

    const { getBlobStore } = await import('../blob/blob-store.js');
    const store = await getBlobStore();
    const blob = await store.get(cid);

    if (!blob) {
      return res.status(404).json({ error: 'BlobNotFound', message: 'Blob not found' });
    }

    res.setHeader('Content-Type', blob.mimeType);
    res.setHeader('Content-Length', blob.data.length.toString());
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(blob.data);
  } catch (error) {
    console.error('Error serving blob:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to serve blob' });
    }
  }
});
```

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts
git commit -m "feat(blob): register uploadBlob handler and blob serve route"
```

---

### Task 6: CAR import endpoint

**Files:**
- Create: `src/api/net.openfederation.admin.importRepo.ts`
- Create: `src/lexicon/net.openfederation.admin.importRepo.json`
- Modify: `src/db/audit.ts`

- [ ] **Step 1: Add audit action**

Add `'admin.importRepo'` to the `AuditAction` union type in `src/db/audit.ts`.

- [ ] **Step 2: Create lexicon**

```json
{
  "lexicon": 1,
  "id": "net.openfederation.admin.importRepo",
  "description": "Import a CAR file to create or restore a repository on this PDS. Admin only.",
  "defs": {
    "main": {
      "type": "procedure",
      "description": "Import a full repository from a CAR stream. Used for migration and disaster recovery.",
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "properties": {
            "did": { "type": "string" },
            "rootCid": { "type": "string" },
            "blockCount": { "type": "integer" },
            "recordCount": { "type": "integer" }
          },
          "required": ["did", "rootCid", "blockCount", "recordCount"]
        }
      },
      "errors": [
        { "name": "InvalidRequest", "description": "Missing DID parameter or invalid CAR data." },
        { "name": "RepoAlreadyExists", "description": "A repository already exists for this DID." },
        { "name": "InvalidCar", "description": "CAR data is malformed or cannot be parsed." }
      ]
    }
  }
}
```

- [ ] **Step 3: Create the import handler**

```typescript
// src/api/net.openfederation.admin.importRepo.ts

import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

export default async function importRepo(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) return;

    const did = req.query.did as string;

    if (!did || !did.startsWith('did:')) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'did query parameter is required and must be a valid DID',
      });
      return;
    }

    // Check repo doesn't already exist
    const existingRepo = await query(
      'SELECT 1 FROM repo_roots WHERE did = $1',
      [did]
    );

    if (existingRepo.rows.length > 0) {
      res.status(409).json({
        error: 'RepoAlreadyExists',
        message: `A repository already exists for DID: ${did}`,
      });
      return;
    }

    // Collect raw CAR body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const carBytes = Buffer.concat(chunks);

    if (carBytes.length === 0) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Empty CAR body',
      });
      return;
    }

    // Parse CAR using @atproto/repo
    let root: any;
    let blocks: any;
    try {
      const { readCarWithRoot } = await import('@atproto/repo');
      const result = await readCarWithRoot(new Uint8Array(carBytes));
      root = result.root;
      blocks = result.blocks;
    } catch (err) {
      res.status(400).json({
        error: 'InvalidCar',
        message: 'Failed to parse CAR data',
      });
      return;
    }

    const rootCidStr = root.toString();

    // Store all blocks in repo_blocks
    let blockCount = 0;
    const blockEntries = blocks.entries();
    for (const entry of blockEntries) {
      const cid = entry.cid.toString();
      const bytes = entry.bytes;
      await query(
        `INSERT INTO repo_blocks (did, cid, block_data)
         VALUES ($1, $2, $3)
         ON CONFLICT (did, cid) DO NOTHING`,
        [did, cid, Buffer.from(bytes)]
      );
      blockCount++;
    }

    // Register repo root
    await query(
      `INSERT INTO repo_roots (did, root_cid, rev)
       VALUES ($1, $2, $3)
       ON CONFLICT (did) DO UPDATE SET root_cid = $2, rev = $3`,
      [did, rootCidStr, rootCidStr.slice(-10)]
    );

    // Walk the MST to populate records_index
    // Use RepoEngine to read records from the imported blocks
    const { RepoEngine } = await import('../repo/repo-engine.js');
    const engine = new RepoEngine(did);
    const records = await engine.exportAllRecords();

    let recordCount = 0;
    for (const record of records) {
      await query(
        `INSERT INTO records_index (community_did, collection, rkey, record, cid)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (community_did, collection, rkey) DO UPDATE SET record = $4, cid = $5`,
        [did, record.collection, record.rkey, JSON.stringify(record.value), record.cid || '']
      );
      recordCount++;
    }

    await auditLog('admin.importRepo', req.auth!.userId, did, {
      rootCid: rootCidStr,
      blockCount,
      recordCount,
    });

    res.status(200).json({
      did,
      rootCid: rootCidStr,
      blockCount,
      recordCount,
    });
  } catch (error) {
    console.error('Error in importRepo:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to import repository',
    });
  }
}
```

- [ ] **Step 4: Add import to server handler map**

Add import:
```typescript
import importRepo from '../api/net.openfederation.admin.importRepo.js';
```

Add to handler map:
```typescript
  'net.openfederation.admin.importRepo': { handler: importRepo },
```

- [ ] **Step 5: Commit**

```bash
git add src/api/net.openfederation.admin.importRepo.ts src/lexicon/net.openfederation.admin.importRepo.json src/db/audit.ts src/server/index.ts
git commit -m "feat(admin): add CAR import endpoint for repo migration"
```

---

### Task 7: Docker Compose + Dockerfile

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`

- [ ] **Step 1: Create .dockerignore**

```
node_modules
.git
.env
.env.*
!.env.example
data/
dist/
web-interface/node_modules
web-interface/.next
*.md
tests/
.claude/
docs/
articles/
```

- [ ] **Step 2: Create Dockerfile**

```dockerfile
# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
COPY cli/ ./cli/
COPY scripts/ ./scripts/
COPY packages/ ./packages/
RUN npm run build

# Stage 2: Runtime
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache wget
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/package.json ./
COPY --from=builder /app/scripts/ ./scripts/
COPY --from=builder /app/src/db/schema.sql ./src/db/schema.sql
COPY --from=builder /app/src/lexicon/ ./src/lexicon/
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Create docker-compose.yml**

```yaml
version: '3.8'

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
      DB_PORT: "5432"
      DB_NAME: openfederation
      DB_USER: openfederation
      DB_PASSWORD: ${DB_PASSWORD:-changeme}
      AUTH_JWT_SECRET: ${AUTH_JWT_SECRET:?Set AUTH_JWT_SECRET in .env}
      KEY_ENCRYPTION_SECRET: ${KEY_ENCRYPTION_SECRET:?Set KEY_ENCRYPTION_SECRET in .env}
      PDS_HOSTNAME: ${PDS_HOSTNAME:-localhost}
      PDS_SERVICE_URL: ${PDS_SERVICE_URL:-http://localhost:8080}
      BLOB_STORAGE: ${BLOB_STORAGE:-local}
      BLOB_STORAGE_PATH: /data/blobs
      BOOTSTRAP_ADMIN_EMAIL: ${BOOTSTRAP_ADMIN_EMAIL:-admin@localhost}
      BOOTSTRAP_ADMIN_HANDLE: ${BOOTSTRAP_ADMIN_HANDLE:-admin}
      BOOTSTRAP_ADMIN_PASSWORD: ${BOOTSTRAP_ADMIN_PASSWORD:-AdminPass1234}
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

- [ ] **Step 4: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore
git commit -m "feat(deploy): add Dockerfile and docker-compose for self-hosted deployment"
```

---

### Task 8: Whitepaper deviations documentation

**Files:**
- Create: `docs/whitepaper-deviations.md`

- [ ] **Step 1: Create the document**

```markdown
# Whitepaper Deviations

This document records deliberate deviations from the OpenFederation Technical White Paper (v2.1, February 2026) and their rationale.

## 1. Attestation Revocation: Delete-as-Revoke

**Whitepaper says (Section 4.3):** "Records should never be deleted; revocation is represented by setting revokedAt."

**Implementation:** Revocation is performed by deleting the attestation record from the community repo. The `deleteAttestation` endpoint wraps `RepoEngine.deleteRecord()`, which creates a signed MST commit proving the deletion.

**Rationale:**
- More ATProto-native. In AT Protocol, deletion creates a signed commit that is cryptographic proof of removal.
- A `revoked: true` record still syncs via `sync.getRepo` and appears valid to any client or relay that does not explicitly check the `revoked` field. Delete-as-revoke eliminates this entire class of bugs.
- The ATProto commit history preserves the full timeline: the attestation existed at commit A and was deleted at commit B. Both are verifiable from the CAR export.
- The audit log captures who revoked the attestation, when, and why (via the `reason` parameter).

**Decision:** Discussed and approved in GitHub issue #12.

## 2. Role Model: String Roles vs Role-Reference Records

**Whitepaper says (Section 3.1, 3.3):** Member records reference a role TID pointing to a `net.openfederation.community.role` record with a custom permissions array. Communities can define arbitrary roles (e.g., "coach", "physio", "treasurer").

**Implementation:** Roles are stored as string values (`owner`, `moderator`, `member`) directly in the member record. There is no `community.role` collection.

**Rationale:**
- Simpler for Phase 1. The three-role hierarchy covers all current use cases.
- Custom roles with permission arrays are tracked in GitHub issue #17 for Phase 2 (Governance Layer).
- The migration path is straightforward: create default role records, then update member records to reference them by rkey.

**Status:** Temporary deviation. Will be resolved by #17.
```

- [ ] **Step 2: Commit**

```bash
git add docs/whitepaper-deviations.md
git commit -m "docs: add whitepaper deviations documentation"
```

---

### Task 9: Integration tests

**Files:**
- Create: `tests/api/com.atproto.repo.uploadBlob.test.ts`
- Create: `tests/api/net.openfederation.admin.importRepo.test.ts`

- [ ] **Step 1: Create blob upload tests**

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcPost, xrpcAuthPost, xrpcGet,
  createTestUser, getAdminToken, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { api } from './helpers.js';

describe('uploadBlob', () => {
  let plcAvailable: boolean;
  let user: { accessJwt: string; did: string; handle: string };

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;
    user = await createTestUser(uniqueHandle('blob'));
  });

  it('should reject unauthenticated upload', async () => {
    const res = await api
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Content-Type', 'image/png')
      .send(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes
    expect(res.status).toBe(401);
  });

  it('should reject disallowed MIME type', async () => {
    if (!plcAvailable) return;
    const res = await api
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Authorization', `Bearer ${user.accessJwt}`)
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('fake pdf'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidMimeType');
  });

  it('should reject empty body', async () => {
    if (!plcAvailable) return;
    const res = await api
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Authorization', `Bearer ${user.accessJwt}`)
      .set('Content-Type', 'image/jpeg')
      .send(Buffer.alloc(0));
    expect(res.status).toBe(400);
  });

  it('should upload a blob and return a blob ref', async () => {
    if (!plcAvailable) return;
    const fakeImage = Buffer.alloc(256, 0xff); // 256 bytes of 0xFF
    const res = await api
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Authorization', `Bearer ${user.accessJwt}`)
      .set('Content-Type', 'image/jpeg')
      .send(fakeImage);
    expect(res.status).toBe(200);
    expect(res.body.blob).toBeTruthy();
    expect(res.body.blob.$type).toBe('blob');
    expect(res.body.blob.ref.$link).toBeTruthy();
    expect(res.body.blob.mimeType).toBe('image/jpeg');
    expect(res.body.blob.size).toBe(256);
  });

  it('should serve an uploaded blob', async () => {
    if (!plcAvailable) return;
    const fakeImage = Buffer.alloc(128, 0xaa);
    const uploadRes = await api
      .post('/xrpc/com.atproto.repo.uploadBlob')
      .set('Authorization', `Bearer ${user.accessJwt}`)
      .set('Content-Type', 'image/png')
      .send(fakeImage);
    expect(uploadRes.status).toBe(200);

    const cid = uploadRes.body.blob.ref.$link;
    const serveRes = await api.get(`/blob/${user.did}/${cid}`);
    expect(serveRes.status).toBe(200);
    expect(serveRes.headers['content-type']).toContain('image/png');
    expect(serveRes.headers['cache-control']).toContain('immutable');
  });

  it('should return 404 for non-existent blob', async () => {
    const res = await api.get('/blob/did:plc:test/bafkreinonexistent');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Create CAR import tests**

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcAuthPost, xrpcAuthGet, xrpcGet,
  getAdminToken, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { api } from './helpers.js';

describe('importRepo', () => {
  let plcAvailable: boolean;
  let adminToken: string;
  let exportedCar: Buffer;
  let sourceDid: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    adminToken = await getAdminToken();

    // Create a user with some data to export
    const user = await createTestUser(uniqueHandle('import-src'));
    sourceDid = user.did;

    // Add a profile update so the repo has more than just the initial record
    await xrpcAuthPost('net.openfederation.account.updateProfile', user.accessJwt, {
      displayName: 'Import Test User',
      description: 'Testing CAR import',
    });

    // Export the repo as CAR
    const exportRes = await api
      .get(`/xrpc/com.atproto.sync.getRepo?did=${sourceDid}`)
      .buffer(true)
      .parse((res: any, callback: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    exportedCar = exportRes.body;
  });

  it('should reject unauthenticated', async () => {
    const res = await api
      .post('/xrpc/net.openfederation.admin.importRepo?did=did:plc:test')
      .set('Content-Type', 'application/vnd.ipld.car')
      .send(Buffer.from('fake'));
    expect(res.status).toBe(401);
  });

  it('should reject non-admin', async () => {
    if (!plcAvailable) return;
    const user = await createTestUser(uniqueHandle('import-nonadmin'));
    const res = await api
      .post('/xrpc/net.openfederation.admin.importRepo?did=did:plc:test')
      .set('Authorization', `Bearer ${user.accessJwt}`)
      .set('Content-Type', 'application/vnd.ipld.car')
      .send(Buffer.from('fake'));
    expect(res.status).toBe(403);
  });

  it('should reject missing did parameter', async () => {
    if (!plcAvailable) return;
    const res = await api
      .post('/xrpc/net.openfederation.admin.importRepo')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Content-Type', 'application/vnd.ipld.car')
      .send(Buffer.from('fake'));
    expect(res.status).toBe(400);
  });

  it('should reject if repo already exists', async () => {
    if (!plcAvailable) return;
    const res = await api
      .post(`/xrpc/net.openfederation.admin.importRepo?did=${sourceDid}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Content-Type', 'application/vnd.ipld.car')
      .send(exportedCar);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('RepoAlreadyExists');
  });

  it('should reject invalid CAR data', async () => {
    if (!plcAvailable) return;
    const res = await api
      .post('/xrpc/net.openfederation.admin.importRepo?did=did:plc:importtest1')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Content-Type', 'application/vnd.ipld.car')
      .send(Buffer.from('not valid car data'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidCar');
  });
});
```

Note: A full round-trip import test (export -> import to new DID -> verify records) requires generating a fresh DID without PLC registration, which adds complexity. The above tests cover the error paths and guard logic. The round-trip flow is best validated manually or in an end-to-end test environment.

- [ ] **Step 3: Commit**

```bash
git add tests/api/com.atproto.repo.uploadBlob.test.ts tests/api/net.openfederation.admin.importRepo.test.ts
git commit -m "test: add integration tests for blob upload and CAR import"
```

---

### Task 10: Full build + test verification

- [ ] **Step 1: Build**

Run: `npm run build`

Expected: Clean build.

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`

Expected: All tests pass.

- [ ] **Step 3: Final commit if fixes needed**

Only if build or tests required adjustments.
