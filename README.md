# openfederation-pds
Personal Data Server (PDS) for OpenFederation communities, built on the AT Protocol.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your database credentials and secrets
./scripts/init-db.sh   # or: npm run db:init
npm run build
npm start
```

### Web UI

```bash
cd web-interface
npm install
cp .env.example .env.local
# Edit .env.local — set NEXT_PUBLIC_PDS_URL to your PDS server URL
npm run build
npm start              # Starts on $PORT (default 3000)
```

For local development, run both in parallel:
```bash
# Terminal 1: PDS API (port 8080 or as configured in .env)
npm run dev

# Terminal 2: Web UI (port 3001)
cd web-interface && PORT=3001 npm run dev
```

### Required Environment Variables

| Variable | Required In | Description |
|----------|:---:|-------------|
| `AUTH_JWT_SECRET` | Production | Random string, minimum 32 characters. Server refuses to start without it. |
| `KEY_ENCRYPTION_SECRET` | Production | Encrypts recovery/signing keys at rest. Must be set before creating communities. |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | All | PostgreSQL connection. |
| `DB_SSL` | Production | `true` for SSL connections. |
| `CORS_ORIGINS` | Production | Web UI URL (e.g., `https://your-web-ui.up.railway.app`). |
| `INVITE_REQUIRED` | All | `true` (default) for invite-only registration. |
| `BOOTSTRAP_ADMIN_EMAIL` / `HANDLE` / `PASSWORD` | First run | Creates an admin user on startup. |

See `.env.example` for all options including CORS, token TTLs, and pool tuning.

## First Admin Login

1. Set `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_HANDLE`, and `BOOTSTRAP_ADMIN_PASSWORD` in your environment
2. Start the PDS with a connected database — check logs for `✓ Bootstrap admin user created`
3. Open the Web UI and log in with the handle and password you configured
4. You have full admin access: create communities, approve users, manage invites, moderate communities
5. After verifying login, remove the `BOOTSTRAP_ADMIN_*` variables — the account persists in the database

## Deployment

For Railway deployment (recommended), see **[RAILWAY.md](./RAILWAY.md)**.

The project deploys as three Railway services from the same repo:
- **PDS API** (root directory) — Express.js backend on standard HTTPS
- **PLC Directory** (`plc-server/` directory) — DID PLC resolution service with its own PostgreSQL
- **Web UI** (`web-interface/` directory) — Next.js dashboard on standard HTTPS

For Docker and other platforms, see **[DEPLOYMENT.md](./DEPLOYMENT.md)**.

## Authentication and Admin Flow

### Roles
- **admin**: full access — manage users, communities, moderation (suspend/takedown), view audit log, server stats
- **moderator**: approve/reject users, create and list invites, list accounts
- **user**: can create communities once approved

### Account Status Lifecycle

| Status | Description |
|--------|-------------|
| `pending` | Newly registered, awaiting admin/moderator approval. |
| `approved` | Active account, can log in and use the system. |
| `rejected` | Registration denied by admin/moderator. |
| `disabled` | Previously approved account disabled by admin. |

### Typical Flow

1. Bootstrap admin is created on first startup (via `.env` variables).
2. Admin creates invite codes.
3. Users register with an invite code (status = `pending`).
4. Admin/moderator approves the user.
5. User logs in and creates communities.

### Password Requirements

Passwords must be 10-128 characters and contain at least 3 of 4 categories: lowercase, uppercase, digit, special character.

### Handle Requirements

Handles must be 3-30 characters: lowercase letters, numbers, and hyphens. No leading/trailing hyphens, no consecutive hyphens. Some names (admin, root, system, etc.) are reserved.

## API Endpoints

All endpoints are XRPC methods at `/xrpc/{nsid}`. Formal lexicon schemas for all custom endpoints are in `src/lexicon/`.

### ATProto Sessions

| NSID | Method | Auth | Description |
|------|:---:|:---:|-------------|
| `com.atproto.server.createSession` | POST | No | Login |
| `com.atproto.server.refreshSession` | POST | Yes | Rotate refresh token (with reuse detection) |
| `com.atproto.server.getSession` | GET | Yes | Get current session |
| `com.atproto.server.deleteSession` | POST | Yes | Logout |
| `com.atproto.repo.getRecord` | GET | No | Fetch a record |
| `com.atproto.repo.putRecord` | POST | Yes | Write a record (real MST signed commit) |
| `com.atproto.repo.createRecord` | POST | Yes | Create a record with auto-generated TID rkey |
| `com.atproto.repo.deleteRecord` | POST | Yes | Delete a record (signed commit) |
| `com.atproto.repo.describeRepo` | GET | No | Repo metadata and available collections |
| `com.atproto.repo.listRecords` | GET | No | Paginated record listing |
| `com.atproto.sync.getRepo` | GET | No | Full repo as CAR stream (federation) |

### Account Management

| NSID | Method | Auth | Description |
|------|:---:|:---:|-------------|
| `net.openfederation.account.register` | POST | No | Register (invite required) |
| `net.openfederation.account.listPending` | GET | Admin/Mod | List pending users |
| `net.openfederation.account.list` | GET | Admin/Mod | List all accounts (search, filter by status/role) |
| `net.openfederation.account.approve` | POST | Admin/Mod | Approve user |
| `net.openfederation.account.reject` | POST | Admin/Mod | Reject user |
| `net.openfederation.invite.create` | POST | Admin/Mod | Create invite code |
| `net.openfederation.invite.list` | GET | Admin/Mod | List invite codes (filter by status) |

### Community Management

| NSID | Method | Auth | Description |
|------|:---:|:---:|-------------|
| `net.openfederation.community.create` | POST | Approved | Create community (did:plc or did:web) |
| `net.openfederation.community.get` | GET | No | Get community details (auth optional for membership info) |
| `net.openfederation.community.listAll` | GET | Yes | Browse public communities (excludes user's own; admin mode=all shows everything) |
| `net.openfederation.community.listMine` | GET | Yes | List my communities with role |
| `net.openfederation.community.update` | POST | Owner | Update community settings |
| `net.openfederation.community.join` | POST | Approved | Join (open) or request to join (approval). Re-request after rejection allowed. |
| `net.openfederation.community.leave` | POST | Member | Leave community (owner cannot leave) |
| `net.openfederation.community.listMembers` | GET | Yes | List members (private communities: members/owner/admin only) |
| `net.openfederation.community.listJoinRequests` | GET | Owner/Admin | List pending join requests |
| `net.openfederation.community.resolveJoinRequest` | POST | Owner/Admin | Approve/reject join request |
| `net.openfederation.community.removeMember` | POST | Owner/Admin | Remove (kick) a member from a community |
| `net.openfederation.community.delete` | POST | Owner/Admin | Permanently delete a community and all its data |

### AT Protocol Compliance (Moderation & Portability)

| NSID | Method | Auth | Description |
|------|:---:|:---:|-------------|
| `net.openfederation.community.export` | GET | Owner/Admin | Export full community data as JSON archive |
| `net.openfederation.community.suspend` | POST | PDS Admin | Suspend a community (reversible) |
| `net.openfederation.community.unsuspend` | POST | PDS Admin | Lift a community suspension |
| `net.openfederation.community.takedown` | POST | PDS Admin | Take down a community (requires prior export) |
| `net.openfederation.community.transfer` | POST | Owner | Initiate transfer to another PDS |

Communities follow the AT Protocol "free to go" principle:
- Owners can always export their community data
- Suspended communities remain readable by owners for export
- Takedown requires that an export has been performed first
- Transfer generates a package with migration instructions for did:plc or did:web
- **Transfer is owner-only** per AT Protocol — the DID holder initiates migration, not the PDS admin

### Administration

| NSID | Method | Auth | Description |
|------|:---:|:---:|-------------|
| `net.openfederation.audit.list` | GET | PDS Admin | List audit log entries (filter by action, actor, target, date range) |
| `net.openfederation.server.getConfig` | GET | PDS Admin | Get server config and statistics |

## Web Interface

The web UI (`web-interface/`) is built with Next.js 15, shadcn/ui, React Query v5, and kbar.

### Features

- **Sidebar shell** with navigation (Dashboard, My Communities, Explore) and admin section
- **Command palette** (Ctrl+K) for quick navigation and admin actions
- **Dashboard** with stat cards and quick actions
- **Community management**: create, browse, join, leave, member management, settings
- **Admin pages**: Users (search/filter/approve/reject), Communities (suspend/unsuspend/takedown/delete), Invites (create/list), Audit Log (filter/search)
- **Data tables** with server-side pagination via @tanstack/react-table
- **Settings** page with account info display

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router) |
| UI | shadcn/ui + Tailwind CSS |
| Server state | React Query v5 (30s staleTime, 5min gcTime) |
| Auth state | Zustand (persisted refresh token) |
| Data tables | @tanstack/react-table |
| Command palette | kbar |
| Notifications | Sonner |

## Example Requests

Create invite (admin/moderator):
```bash
curl -X POST http://localhost:8080/xrpc/net.openfederation.invite.create \
  -H "Authorization: Bearer <accessJwt>" \
  -H "Content-Type: application/json" \
  -d '{"maxUses":1}'
```

Register (invite required):
```bash
curl -X POST http://localhost:8080/xrpc/net.openfederation.account.register \
  -H "Content-Type: application/json" \
  -d '{
    "handle": "alice",
    "email": "alice@example.com",
    "password": "MyStr0ng!Pass",
    "inviteCode": "<invite>"
  }'
```

Approve user (admin/moderator):
```bash
curl -X POST http://localhost:8080/xrpc/net.openfederation.account.approve \
  -H "Authorization: Bearer <accessJwt>" \
  -H "Content-Type: application/json" \
  -d '{"handle":"alice"}'
```

Login (approved user):
```bash
curl -X POST http://localhost:8080/xrpc/com.atproto.server.createSession \
  -H "Content-Type: application/json" \
  -d '{"identifier":"alice","password":"MyStr0ng!Pass"}'
```

Create community (approved user):
```bash
curl -X POST http://localhost:8080/xrpc/net.openfederation.community.create \
  -H "Authorization: Bearer <accessJwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "handle": "my-community",
    "didMethod": "plc",
    "displayName": "My Community"
  }'
```

Export community (owner):
```bash
curl 'http://localhost:8080/xrpc/net.openfederation.community.export?did=did:plc:abc123' \
  -H "Authorization: Bearer <accessJwt>"
```

Logout:
```bash
curl -X POST http://localhost:8080/xrpc/com.atproto.server.deleteSession \
  -H "Authorization: Bearer <accessJwt>" \
  -H "Content-Type: application/json" \
  -d '{"refreshJwt":"<refreshJwt>"}'
```

## Rate Limits

| Scope | Limit |
|-------|-------|
| Global | 120 requests/minute per IP |
| Authentication | 20 attempts per 15 minutes per IP |
| Registration | 5 per hour per IP |
| Community creation | 10 per hour per IP |

## CLI

The CLI provides command-line access to all major operations. See `cli/README.md` for full documentation.

```bash
npm run build
npm run cli -- login -u admin -p 'password'
npm run cli -- create-invite
npm run cli -- list-pending
npm run cli -- approve-user -h alice
npm run cli -- create-community -n my-community -d "My Community"
npm run cli -- whoami
npm run cli -- logout
```

## Security

- JWT access tokens with configurable TTL. Refresh token rotation with reuse detection.
- Recovery keys and signing keys encrypted at rest (AES-256-GCM).
- Primary rotation key returned to user once, never stored by the server.
- Sanitized error messages. Request body limit of 256kb.
- Audit logging for all admin, moderation, and security-relevant actions.
- Community moderation follows AT Protocol composable moderation: suspend (reversible) and takedown (requires prior export).
- Approve/reject endpoints guard against re-processing already-resolved users.

## Lexicon Schemas

AT Protocol lexicon definitions for all 26 custom `net.openfederation.*` endpoints are in `src/lexicon/`. These define the formal request/response schemas following the [AT Protocol Lexicon specification](https://atproto.com/specs/lexicon).

## Development

```bash
npm run dev          # Start PDS with ts-node (ESM)
npm run build        # TypeScript compile
npm run db:check     # Check database connectivity
npm run cli:dev      # Run CLI without building
npm run plc:dev      # Start local PLC directory on port 2582
```
