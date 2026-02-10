# Railway Deployment Guide

OpenFederation PDS deploys to Railway as **two services** from the same repository:

| Service | What it does | Root directory |
|---------|-------------|----------------|
| **PDS API** | Express.js backend, XRPC endpoints, PostgreSQL | `/` (repo root) |
| **Web UI** | Next.js dashboard for managing communities | `/web-interface` |

Both services get their own Railway-generated URL on **standard HTTPS (port 443)**. Railway handles TLS termination automatically.

---

## 1. Create the Railway Project

```bash
# Option A: Railway CLI
railway login
railway init

# Option B: Dashboard
# Go to https://railway.app/new → "Deploy from GitHub repo" → select your repo
```

---

## 2. Add PostgreSQL

In Railway Dashboard:

1. Click **"+ New"** → **"Database"** → **"Add PostgreSQL"**
2. Railway auto-configures: `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`

---

## 3. Configure the PDS API Service

Railway will auto-detect the root `railway.json` and create the first service. Click the service and set these **Variables**:

### Required Variables

```
NODE_ENV=production

# Auth — generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
AUTH_JWT_SECRET=<random-64-char-hex>
KEY_ENCRYPTION_SECRET=<random-64-char-hex>

# PDS identity — use your Railway-generated domain or custom domain
PDS_HOSTNAME=your-pds.up.railway.app
PDS_SERVICE_URL=https://your-pds.up.railway.app

# Database — use Railway reference variables to auto-wire
DB_HOST=${{Postgres.PGHOST}}
DB_PORT=${{Postgres.PGPORT}}
DB_NAME=${{Postgres.PGDATABASE}}
DB_USER=${{Postgres.PGUSER}}
DB_PASSWORD=${{Postgres.PGPASSWORD}}
DB_SSL=true
```

### Bootstrap Admin (first-time setup)

Set these three variables to create the initial admin account on first boot:

```
BOOTSTRAP_ADMIN_EMAIL=admin@yourdomain.com
BOOTSTRAP_ADMIN_HANDLE=admin
BOOTSTRAP_ADMIN_PASSWORD=<strong-password>
```

The PDS creates this user automatically on startup with **admin + moderator + user** roles, pre-approved. You can remove these variables after the first successful boot — the account persists in the database.

### CORS

Set after you create the Web UI service (Step 4) — you'll need its URL:

```
CORS_ORIGINS=https://your-web-ui.up.railway.app
```

### Optional Variables

```
HANDLE_SUFFIX=.openfederation.net
PLC_DIRECTORY_URL=https://plc.directory
INVITE_REQUIRED=true
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL=30d
```

**Note:** Do NOT set `PORT` — Railway assigns it automatically.

---

## 4. Add the Web UI Service

In Railway Dashboard:

1. Click **"+ New"** → **"GitHub Repo"** → select the **same repository**
2. Railway creates a second service. Click it and configure:

### Service Settings

- **Root Directory:** `web-interface`
  *(Settings → General → Root Directory)*
- Railway will detect `web-interface/railway.json` automatically

### Variables

```
NEXT_PUBLIC_PDS_URL=https://your-pds.up.railway.app
```

This tells the web UI where the PDS API lives. Use the PDS service's public URL from Step 3.

**Note:** Do NOT set `PORT` — Railway assigns it. The Next.js start script reads `$PORT` automatically.

---

## 5. Initialize the Database Schema

After both services deploy, run the schema migration:

```bash
# Option A: Railway CLI
railway run psql $DATABASE_URL -f src/db/schema.sql

# Option B: Connect directly
railway connect postgres
# Then paste the contents of src/db/schema.sql
```

---

## 6. Verify Deployment

### Check PDS health

```bash
curl https://your-pds.up.railway.app/health
```

Expected:
```json
{
  "status": "ok",
  "database": "connected",
  "timestamp": "2026-02-07T..."
}
```

### Check Web UI

Open `https://your-web-ui.up.railway.app` in your browser. You should see the login page.

---

## 7. First Admin Login

1. Open the Web UI: `https://your-web-ui.up.railway.app/login`
2. Log in with the bootstrap admin credentials you configured:
   - **Handle or Email:** the `BOOTSTRAP_ADMIN_HANDLE` or `BOOTSTRAP_ADMIN_EMAIL` you set
   - **Password:** the `BOOTSTRAP_ADMIN_PASSWORD` you set
3. You'll land on the dashboard with full admin access:
   - **Communities** — create and manage communities
   - **Explore** — browse public communities
   - **Admin** — manage users, pending approvals, and all communities

### After logging in

- Create your first community from the **Communities** page
- Go to **Admin** → **Communities** tab to see all communities and moderation controls
- Go to **Admin** → **Users** tab to approve pending users (if `INVITE_REQUIRED=true`)
- You can create invite codes from the dashboard to onboard other users

### Security: Remove bootstrap credentials

After verifying the admin account works, remove the `BOOTSTRAP_ADMIN_*` variables from the PDS service. The account persists in the database — the variables are only needed for the initial creation.

---

## Custom Domain Setup

### For the PDS API

1. Railway Dashboard → PDS service → **Settings** → **Networking** → **Custom Domain**
2. Add your domain (e.g., `pds.yourdomain.com`)
3. Configure DNS: `CNAME pds.yourdomain.com → your-pds.up.railway.app`
4. Update PDS variables:
   ```
   PDS_HOSTNAME=pds.yourdomain.com
   PDS_SERVICE_URL=https://pds.yourdomain.com
   CORS_ORIGINS=https://app.yourdomain.com
   ```

### For the Web UI

1. Railway Dashboard → Web UI service → **Settings** → **Networking** → **Custom Domain**
2. Add your domain (e.g., `app.yourdomain.com`)
3. Configure DNS: `CNAME app.yourdomain.com → your-web-ui.up.railway.app`
4. Update Web UI variable:
   ```
   NEXT_PUBLIC_PDS_URL=https://pds.yourdomain.com
   ```

---

## Troubleshooting

### "Database connection failed"
- Ensure PostgreSQL service is running (green in Dashboard)
- Verify `DB_*` variables use Railway reference syntax: `${{Postgres.PGHOST}}`
- Run the schema: `railway run psql $DATABASE_URL -f src/db/schema.sql`

### "CORS error" in browser console
- Set `CORS_ORIGINS` on the PDS service to the Web UI's exact URL
- Include `https://` — e.g., `https://your-web-ui.up.railway.app`
- Multiple origins: comma-separated — `https://a.com,https://b.com`

### "Network Error" from Web UI
- Verify `NEXT_PUBLIC_PDS_URL` points to the PDS service URL
- This is a **build-time** variable — redeploy the Web UI after changing it

### Build fails
- Check Railway build logs
- Ensure Node.js >=18 (set in `package.json` engines)
- Web UI: verify root directory is set to `web-interface`

### Bootstrap admin not created
- All three `BOOTSTRAP_ADMIN_*` variables must be set
- Database must be connected (check `/health`)
- Check PDS logs for `✓ Bootstrap admin user created`

---

## Architecture Diagram

```
┌─────────────┐     HTTPS (443)     ┌──────────────────┐
│   Browser    │ ──────────────────→ │   Web UI (Next)  │
│              │                     │   Railway auto    │
│              │                     │   assigns PORT    │
└──────┬───────┘                     └──────────────────┘
       │                                      │
       │  HTTPS (443)                         │ NEXT_PUBLIC_PDS_URL
       │                                      ▼
       │                             ┌──────────────────┐
       └───────────────────────────→ │   PDS API (Express)│
                                     │   Railway auto     │
                                     │   assigns PORT     │
                                     └────────┬───────────┘
                                              │
                                              ▼
                                     ┌──────────────────┐
                                     │   PostgreSQL      │
                                     │   (Railway DB)    │
                                     └──────────────────┘
```

Both services are accessible on **standard HTTPS port 443**. Railway handles TLS termination and port routing.

---

## Cost Estimate

Railway Pricing (2026):
- **Hobby Plan:** $5/month base + usage
- **Compute:** ~$0.000463/minute per service
- **PostgreSQL:** included in plan
- **Storage:** ~$0.25/GB/month

Typical monthly cost: **$5–20** for light-to-moderate usage.

---

## Railway CLI Cheat Sheet

```bash
railway login              # Authenticate
railway logs               # View PDS logs
railway logs -s web-ui     # View Web UI logs (use service name)
railway connect postgres   # Connect to database
railway run <cmd>          # Run command in Railway environment
railway open               # Open Dashboard
railway up                 # Deploy from local
```
