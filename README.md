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

### Required Environment Variables

| Variable | Required In | Description |
|----------|:---:|-------------|
| `AUTH_JWT_SECRET` | Production | Random string, minimum 32 characters. Server refuses to start without it. |
| `KEY_ENCRYPTION_SECRET` | Production | Encrypts recovery/signing keys at rest. Must be set before creating communities. |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | All | PostgreSQL connection. |
| `DB_SSL` | Production | `true` for SSL connections. |
| `INVITE_REQUIRED` | All | `true` (default) for invite-only registration. |
| `BOOTSTRAP_ADMIN_EMAIL` / `HANDLE` / `PASSWORD` | First run | Creates an admin user on startup. |

See `.env.example` for all options including CORS, token TTLs, and pool tuning.

## Authentication and Admin Flow

### Roles
- **admin**: full access
- **moderator**: approve/reject users, create invites
- **user**: can create communities once approved

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

### ATProto Sessions

| NSID | Method | Auth | Description |
|------|:---:|:---:|-------------|
| `com.atproto.server.createSession` | POST | No | Login |
| `com.atproto.server.refreshSession` | POST | Yes | Rotate refresh token |
| `com.atproto.server.getSession` | GET | Yes | Get current session |
| `com.atproto.server.deleteSession` | POST | Yes | Logout |
| `com.atproto.repo.getRecord` | GET | No | Fetch a record |

### Account Management

| NSID | Method | Auth | Description |
|------|:---:|:---:|-------------|
| `net.openfederation.account.register` | POST | No | Register (invite required) |
| `net.openfederation.account.listPending` | GET | Admin/Mod | List pending users |
| `net.openfederation.account.approve` | POST | Admin/Mod | Approve user |
| `net.openfederation.account.reject` | POST | Admin/Mod | Reject user |
| `net.openfederation.invite.create` | POST | Admin/Mod | Create invite code |

### Community Management

| NSID | Method | Auth | Description |
|------|:---:|:---:|-------------|
| `net.openfederation.community.create` | POST | Approved | Create community |
| `net.openfederation.community.get` | GET | Optional | Get community details |
| `net.openfederation.community.listAll` | GET | Yes | Browse public communities |
| `net.openfederation.community.listMine` | GET | Yes | List my communities |
| `net.openfederation.community.update` | POST | Owner | Update community |
| `net.openfederation.community.join` | POST | Approved | Join / request to join |
| `net.openfederation.community.leave` | POST | Member | Leave community |
| `net.openfederation.community.listMembers` | GET | Yes | List members |
| `net.openfederation.community.listJoinRequests` | GET | Owner/Admin | List pending join requests |
| `net.openfederation.community.resolveJoinRequest` | POST | Owner/Admin | Approve/reject join request |

## Example Requests

Create invite (admin/moderator):
```bash
curl -X POST http://localhost:3000/xrpc/net.openfederation.invite.create \
  -H "Authorization: Bearer <accessJwt>" \
  -H "Content-Type: application/json" \
  -d '{"maxUses":1}'
```

Register (invite required):
```bash
curl -X POST http://localhost:3000/xrpc/net.openfederation.account.register \
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
curl -X POST http://localhost:3000/xrpc/net.openfederation.account.approve \
  -H "Authorization: Bearer <accessJwt>" \
  -H "Content-Type: application/json" \
  -d '{"handle":"alice"}'
```

Login (approved user):
```bash
curl -X POST http://localhost:3000/xrpc/com.atproto.server.createSession \
  -H "Content-Type: application/json" \
  -d '{"identifier":"alice","password":"MyStr0ng!Pass"}'
```

Create community (approved user):
```bash
curl -X POST http://localhost:3000/xrpc/net.openfederation.community.create \
  -H "Authorization: Bearer <accessJwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "handle": "my-community",
    "didMethod": "plc",
    "displayName": "My Community"
  }'
```

Logout:
```bash
curl -X POST http://localhost:3000/xrpc/com.atproto.server.deleteSession \
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
- Audit logging for all admin and security-relevant actions.
- Approve/reject endpoints guard against re-processing already-resolved users.

## Development

```bash
npm run dev          # Start with ts-node (ESM)
npm run build        # TypeScript compile
npm run db:check     # Check database connectivity
npm run cli:dev      # Run CLI without building
```
