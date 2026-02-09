# OpenFederation PDS CLI

Command-line interface for interacting with the OpenFederation Personal Data Server.

## Quick Start

```bash
# Build (required before first use)
npm run build

# Run the CLI
npm run cli -- <command>

# Or run in dev mode (no build needed)
npm run cli:dev -- <command>
```

## Prerequisites

- Node.js >= 18.0.0
- OpenFederation PDS server running (default: http://localhost:3000)

## Authentication

Most commands require authentication. Log in first:

```bash
npm run cli -- login -u admin -p 'your-password'
```

Session credentials are stored locally in `.pds-cli/session.json` (file permissions 0600). To check your current session:

```bash
npm run cli -- whoami
```

To log out (clears local session and invalidates server-side token):

```bash
npm run cli -- logout
```

## Available Commands

### Session Management

| Command | Auth Required | Description |
|---------|:---:|-------------|
| `login` | No | Log in and store session credentials |
| `logout` | Yes | Log out and clear stored session |
| `whoami` | Yes | Show current logged-in user |

### Server

| Command | Auth Required | Description |
|---------|:---:|-------------|
| `health` | No | Check server health status |
| `info` | No | Get server information |

### User Management (admin/moderator)

| Command | Auth Required | Description |
|---------|:---:|-------------|
| `create-invite` | Yes | Create an invite code |
| `list-pending` | Yes | List pending user registrations |
| `approve-user` | Yes | Approve a pending user |
| `reject-user` | Yes | Reject a pending user |

### Communities

| Command | Auth Required | Description |
|---------|:---:|-------------|
| `create-community` | Yes | Create a new community |
| `get-record` | No | Fetch a record from a repository |

## Command Details

### login

```bash
npm run cli -- login -u <handle-or-email> -p <password>
```

### create-invite

```bash
npm run cli -- create-invite [--max-uses <number>] [--expires <iso-date>]
```

**Options:**
- `--max-uses <number>` - Maximum number of times the code can be used (default: 1)
- `--expires <date>` - Expiration date in ISO 8601 format

### approve-user / reject-user

```bash
npm run cli -- approve-user -h <handle>
npm run cli -- reject-user -h <handle>
```

### create-community

```bash
npm run cli -- create-community -n <handle> -d <display-name> [-m plc|web] [--domain <domain>]
```

**Options:**
- `-n, --handle <handle>` - Community handle (required)
- `-d, --display-name <name>` - Display name (required)
- `-m, --did-method <method>` - DID method: `plc` or `web` (default: `plc`)
- `--domain <domain>` - Domain name (required for `did:web`)

**Important:** When creating a `did:plc` community, save the primary rotation key displayed - you won't see it again!

### get-record

```bash
npm run cli -- get-record -r <did> -c <collection> -k <rkey>
```

**Options:**
- `-r, --repo <did>` - Repository DID (required)
- `-c, --collection <nsid>` - Collection NSID (required)
- `-k, --rkey <rkey>` - Record key (required)

**Common Collections:**
- `net.openfederation.community.profile` - Community profile
- `net.openfederation.community.settings` - Community settings

## Global Options

- `-s, --server <url>` - PDS server URL (default: `http://localhost:3000` or `PDS_SERVICE_URL` env var)
- `--timeout <ms>` - Request timeout in milliseconds (default: 30000)

## Example: Full Admin Workflow

```bash
# 1. Log in as bootstrap admin
npm run cli -- login -u admin -p 'your-admin-password'

# 2. Create an invite code
npm run cli -- create-invite --max-uses 5

# 3. (User registers via web UI or curl with the invite code)

# 4. List pending registrations
npm run cli -- list-pending

# 5. Approve a user
npm run cli -- approve-user -h alice

# 6. Create a community
npm run cli -- create-community -n my-community -d "My Community"

# 7. Fetch the community profile
npm run cli -- get-record \
  -r did:plc:abc123... \
  -c net.openfederation.community.profile \
  -k self
```

## Using a Different Server

```bash
npm run cli -- --server https://pds.example.com health
```

Or set the `PDS_SERVICE_URL` environment variable:

```bash
export PDS_SERVICE_URL=https://pds.example.com
npm run cli -- health
```

## Help

```bash
npm run cli -- --help
npm run cli -- <command> --help
```
