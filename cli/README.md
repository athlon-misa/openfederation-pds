# ofc — OpenFederation CLI

Command-line interface for the OpenFederation Personal Data Server, following [clig.dev](https://clig.dev/) best practices.

## Quick Start

```bash
# Build (required before first use)
npm run build

# Run
npm run cli -- <command>

# Or run in dev mode (no build needed)
npm run cli:dev -- <command>
```

## Authentication

```bash
# Interactive login (prompts for password)
npm run cli -- auth login -u admin

# Scripted login (no TTY needed)
echo "password" | npm run cli -- auth login -u admin --password-stdin

# Check current session
npm run cli -- auth whoami

# Log out
npm run cli -- auth logout
```

Session credentials are stored in `~/.config/ofc/session.json` (XDG-compliant, file permissions 0600).

Passwords are **never** passed as CLI arguments — they are either prompted interactively or read from stdin via `--password-stdin`.

## Output Modes

- **Human-readable** (default): tables, key-value pairs, colored status messages
- **JSON** (`--json`): raw JSON to stdout for piping to `jq`, scripts, etc.
- **No color** (`--no-color` or `NO_COLOR=1`): disables ANSI colors

Messages and errors go to **stderr**. Data goes to **stdout**. This means `ofc community list-mine --json | jq .` works correctly.

## Global Options

| Option | Description |
|--------|-------------|
| `-s, --server <url>` | PDS server URL (default: `$PDS_SERVICE_URL` or `http://localhost:8080`) |
| `--timeout <ms>` | Request timeout in milliseconds (default: 30000) |
| `--json` | Output raw JSON to stdout |
| `--no-color` | Disable ANSI colors |
| `-V, --version` | Show version |
| `-h, --help` | Show help |

## Commands

### `ofc auth` — Authentication

| Command | Description |
|---------|-------------|
| `auth login -u <handle>` | Log in (prompts for password) |
| `auth logout` | Log out and clear session |
| `auth whoami` | Show current user |

### `ofc server` — Server Status

| Command | Auth | Description |
|---------|:---:|-------------|
| `server health` | No | Check server health |
| `server info` | Admin | Get server config and stats |

### `ofc account` — Account Management

| Command | Auth | Description |
|---------|:---:|-------------|
| `account list [--status X] [--search Q]` | Admin/Mod | List all accounts |
| `account list-pending` | Admin/Mod | List pending registrations |
| `account approve <handle>` | Admin/Mod | Approve a pending user |
| `account reject <handle>` | Admin/Mod | Reject a pending user |

### `ofc invite` — Invite Codes

| Command | Auth | Description |
|---------|:---:|-------------|
| `invite create [--max-uses N] [--expires DATE]` | Admin/Mod | Create an invite code |
| `invite list [--status used\|unused\|expired]` | Admin/Mod | List invite codes |

### `ofc community` — Community Management

| Command | Auth | Description |
|---------|:---:|-------------|
| `community create -n <handle> -d <name> [-m plc\|web]` | Approved | Create a community |
| `community get <did>` | Optional | Get community details |
| `community list [--mode all]` | Yes | List public communities |
| `community list-mine` | Yes | List your communities |
| `community update <did> [--display-name] [--description] [--join-policy]` | Owner | Update settings |
| `community join <did>` | Approved | Join or request to join |
| `community leave <did>` | Member | Leave a community |
| `community members <did>` | Yes | List members |
| `community join-requests <did>` | Owner/Admin | List pending join requests |
| `community resolve-request <did> --user <handle> --action approve\|reject` | Owner/Admin | Resolve join request |
| `community remove-member <did> --user <handle>` | Owner/Admin | Remove a member |
| `community delete <did>` | Owner/Admin | Delete community and all data |
| `community export <did>` | Owner/Admin | Export as JSON archive |
| `community suspend <did> [--reason TEXT]` | PDS Admin | Suspend community |
| `community unsuspend <did>` | PDS Admin | Unsuspend community |
| `community takedown <did> [--reason TEXT]` | PDS Admin | Take down (requires prior export) |
| `community transfer <did>` | Owner | Generate transfer package |

### `ofc record` — Repository Records

| Command | Auth | Description |
|---------|:---:|-------------|
| `record get -r <did> -c <collection> -k <rkey>` | No | Fetch a record |
| `record put -r <did> -c <collection> -k <rkey> --data <json>` | Yes | Write a record |
| `record create -r <did> -c <collection> --data <json>` | Yes | Create with auto-key |
| `record delete -r <did> -c <collection> -k <rkey>` | Yes | Delete a record |
| `record list -r <did> -c <collection> [--limit N] [--cursor C]` | No | List records |

The `--data` flag accepts inline JSON or `@filename` to read from a file:

```bash
# Inline JSON
ofc record put -r did:plc:abc -c app.bsky.actor.profile -k self --data '{"displayName":"Alice"}'

# From file
ofc record put -r did:plc:abc -c app.bsky.actor.profile -k self --data @profile.json
```

### `ofc repo` — Repository Operations

| Command | Auth | Description |
|---------|:---:|-------------|
| `repo describe <did>` | No | Show repo metadata and collections |

### `ofc audit` — Audit Log

| Command | Auth | Description |
|---------|:---:|-------------|
| `audit list [--action X] [--actor Y] [--limit N]` | Admin | List audit log entries |

### `ofc attestation` — Community Attestations

| Command | Auth | Description |
|---------|:---:|-------------|
| `attestation issue --did <communityDid> --subject <did> --subject-handle <handle> --type <type> --claim <json>` | Owner/Mod | Issue an attestation |
| `attestation verify --did <communityDid> --rkey <rkey>` | No | Verify attestation (supports remote communities) |
| `attestation list --did <communityDid> [--subject <did>] [--type <type>]` | No | List attestations |
| `attestation delete --did <communityDid> --rkey <rkey> [--reason <reason>]` | Owner/Mod | Revoke attestation (delete-as-revoke) |

### `ofc identity` — External Identity Keys

| Command | Auth | Description |
|---------|:---:|-------------|
| `identity set-key --rkey <rkey> --type <type> --purpose <purpose> --public-key <key>` | Yes | Store an external public key |
| `identity list-keys --did <did> [--purpose <purpose>]` | No | List external keys for a DID |
| `identity delete-key --rkey <rkey>` | Yes | Delete an external key |
| `identity resolve-key --public-key <key> [--purpose <purpose>]` | No | Find ATProto DID by external key |

### `ofc role` — Community Roles

| Command | Auth | Description |
|---------|:---:|-------------|
| `role list --did <communityDid>` | No | List roles and member counts |
| `role create --did <communityDid> --name <name> --permissions <p1,p2,...>` | Owner | Create a custom role |

### `ofc governance` — Community Governance

| Command | Auth | Description |
|---------|:---:|-------------|
| `governance set-model --did <communityDid> --model <model> [--quorum <n>] [--voter-role <role>]` | Owner | Switch governance model |
| `governance propose --did <communityDid> --collection <col> --rkey <rkey> --action <write\|delete> [--record <json>]` | Voter | Create a governance proposal |
| `governance vote --did <communityDid> --proposal <rkey> --vote <for\|against>` | Voter | Vote on a proposal |
| `governance list-proposals --did <communityDid> [--status <status>]` | No | List governance proposals |

### `ofc profile` — User Profiles

| Command | Auth | Description |
|---------|:---:|-------------|
| `profile get --did <did>` | No | Get user profile (standard + custom collections) |
| `profile update [--display-name <name>] [--description <desc>]` | Yes | Update your profile |

### `ofc account sessions` — Session Management

| Command | Auth | Description |
|---------|:---:|-------------|
| `account sessions list` | Yes | List all active sessions |
| `account sessions revoke <id>` | Yes | Revoke a specific session by ID prefix |
| `account sessions revoke-all` | Yes | Revoke all sessions (requires re-login) |

### `ofc security` — Security Diagnostics

| Command | Auth | Description |
|---------|:---:|-------------|
| `security check-config` | Admin | Check server config for security issues |
| `security audit-summary [--days N]` | Admin | Summarize recent security events (default: 7 days) |

### `ofc oracle` — Oracle Credential Management

| Command | Auth | Description |
|---------|:---:|-------------|
| `oracle create <communityDid> --name <label>` | Admin | Create Oracle credential for a community |
| `oracle list [--community <did>]` | Admin | List Oracle credentials |
| `oracle revoke <credentialId>` | Admin | Revoke an Oracle credential |

### Additional Account Commands

| Command | Auth | Description |
|---------|:---:|-------------|
| `account change-password` | Yes | Change password (interactive prompts) |
| `account verify <handle>` | Admin | Send identity verification challenge |
| `account verify-confirm <did> <nonce>` | Admin | Verify identity with nonce |

## Example Workflows

### Admin Setup

```bash
# Log in as bootstrap admin
ofc auth login -u admin

# Create an invite code
ofc invite create --max-uses 5

# (User registers via web UI with the invite code)

# List and approve pending users
ofc account list-pending
ofc account approve alice

# Check who you're logged in as
ofc auth whoami
```

### Community Management

```bash
# Create a community
ofc community create -n my-community -d "My Community"

# List your communities
ofc community list-mine

# View community details
ofc community get did:plc:abc123

# List members
ofc community members did:plc:abc123

# Export community data
ofc community export did:plc:abc123 > backup.json
```

### Scripted Usage

```bash
# JSON output for scripting
ofc community list-mine --json | jq '.[].did'

# Scripted login
echo "$PDS_PASSWORD" | ofc auth login -u admin --password-stdin

# Different server
ofc --server https://pds.example.com server health
```

## Using a Different Server

```bash
ofc --server https://pds.example.com auth login -u admin
```

Or set the `PDS_SERVICE_URL` environment variable:

```bash
export PDS_SERVICE_URL=https://pds.example.com
ofc auth login -u admin
```

## Help

```bash
ofc --help              # Top-level help
ofc auth --help         # Command group help
ofc community create --help  # Specific command help
```
