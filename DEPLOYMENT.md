# Deployment Guide

## Environment Variables

The application requires the following environment variables to be set:

### Required Configuration

```bash
# Database Configuration (Required)
DB_HOST=your-postgres-host       # e.g., localhost, postgres, db.example.com
DB_PORT=5432                      # PostgreSQL port
DB_NAME=openfederation_pds        # Database name
DB_USER=your-db-user              # Database username
DB_PASSWORD=your-db-password      # Database password

# Server Configuration
PORT=3000                         # Port the server will listen on

# PDS Configuration
PDS_HOSTNAME=pds.example.com              # Your PDS hostname
PDS_SERVICE_URL=https://pds.example.com   # Your PDS public URL

# PLC Directory
PLC_DIRECTORY_URL=https://plc.openfederation.net   # Or https://plc.directory for public

# Handle Suffix (Optional - uses default if not set)
HANDLE_SUFFIX=.openfederation.net         # Handle suffix for communities
```

## Docker Deployment

### Using Docker Compose (Recommended)

Create a `docker-compose.yml`:

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: openfederation_pds
      POSTGRES_USER: pds_user
      POSTGRES_PASSWORD: your_secure_password_here
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./src/db/schema.sql:/docker-entrypoint-initdb.d/schema.sql
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pds_user -d openfederation_pds"]
      interval: 10s
      timeout: 5s
      retries: 5

  pds:
    image: node:22-alpine
    working_dir: /app
    volumes:
      - ./:/app
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      PORT: 3000
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: openfederation_pds
      DB_USER: pds_user
      DB_PASSWORD: your_secure_password_here
      PDS_HOSTNAME: pds.example.com
      PDS_SERVICE_URL: https://pds.example.com
      HANDLE_SUFFIX: .openfederation.net
    command: sh -c "npm install && npm run build && npm start"
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  postgres_data:
```

Run with:
```bash
docker-compose up -d
```

### Using Docker Run

1. **Start PostgreSQL:**
```bash
docker run -d \
  --name openfed-postgres \
  -e POSTGRES_DB=openfederation_pds \
  -e POSTGRES_USER=pds_user \
  -e POSTGRES_PASSWORD=your_secure_password \
  -v postgres_data:/var/lib/postgresql/data \
  -p 5432:5432 \
  postgres:15-alpine
```

2. **Initialize database schema:**
```bash
docker exec -i openfed-postgres psql -U pds_user -d openfederation_pds < src/db/schema.sql
```

3. **Start the PDS:**
```bash
docker run -d \
  --name openfed-pds \
  --link openfed-postgres:postgres \
  -e DB_HOST=postgres \
  -e DB_PORT=5432 \
  -e DB_NAME=openfederation_pds \
  -e DB_USER=pds_user \
  -e DB_PASSWORD=your_secure_password \
  -e PORT=3000 \
  -e PDS_HOSTNAME=pds.example.com \
  -e PDS_SERVICE_URL=https://pds.example.com \
  -p 3000:3000 \
  -v $(pwd):/app \
  -w /app \
  node:22-alpine \
  sh -c "npm install && npm run build && npm start"
```

## Railway Deployment

For complete Railway deployment instructions (two-service setup, bootstrap admin, HTTPS configuration), see **[RAILWAY.md](./RAILWAY.md)**.

Quick summary: deploy as three Railway services (PDS API + PLC Directory + Web UI) from the same repo, each on standard HTTPS. Railway handles TLS and port assignment automatically.

## First Admin Login

The PDS supports automatic admin bootstrap via environment variables. On first startup with a connected database, if all three bootstrap variables are set, an admin account is created automatically.

### Setup

Set these environment variables before the first boot:

```bash
BOOTSTRAP_ADMIN_EMAIL=admin@yourdomain.com
BOOTSTRAP_ADMIN_HANDLE=admin
BOOTSTRAP_ADMIN_PASSWORD=<strong-password-here>
```

The account is:
- Pre-approved (no manual approval needed)
- Granted **admin**, **moderator**, and **user** roles
- Ready to log in immediately

### Logging In

1. Open the Web UI at your deployment URL (e.g., `https://your-web-ui.up.railway.app/login`)
2. Enter the handle (or email) and password you configured
3. You'll see the dashboard with full admin privileges

### What You Can Do as Admin

- **Communities** — create communities with did:plc or did:web identity
- **Explore** — browse all public communities
- **Admin panel:**
  - **Users** tab — approve/reject pending registrations
  - **Invites** tab — generate invite codes for new users
  - **Communities** tab — view all communities, suspend/unsuspend for moderation

### Security

After the admin account is created, **remove the `BOOTSTRAP_ADMIN_*` variables** from your environment. The account persists in the database. If the account already exists on subsequent boots, the PDS just ensures it has admin role (idempotent).

---

## Vercel/Netlify/Cloud Functions

**Note:** This application requires a persistent PostgreSQL database and long-running processes. It is **not suitable** for serverless platforms like Vercel or Netlify Functions.

Use traditional hosting (VPS, Railway, Render, Fly.io) or containerized deployments instead.

## Health Check

After deployment, verify the application is running:

```bash
curl https://your-pds-url/health
```

Expected response:
```json
{
  "status": "ok",
  "database": "connected",
  "timestamp": "2026-02-05T21:00:00.000Z"
}
```

If database is not connected:
```json
{
  "status": "degraded",
  "database": "disconnected",
  "timestamp": "2026-02-05T21:00:00.000Z"
}
```

## Troubleshooting

### Database Connection Failed

If you see: `Database connection failed: connect ECONNREFUSED`

**Check:**
1. PostgreSQL is running and accessible
2. Environment variables are correctly set:
   ```bash
   echo $DB_HOST
   echo $DB_PORT
   echo $DB_USER
   ```
3. Database exists:
   ```bash
   psql -h $DB_HOST -U $DB_USER -l
   ```
4. Network connectivity between app and database
5. Firewall rules allow connection on port 5432

### Database Schema Not Initialized

The PDS auto-initializes its schema on first startup. If you see errors about missing tables, check that the database connection is working (the auto-migration only runs when connected). For manual initialization:

```bash
psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f src/db/schema.sql
```

### Server Won't Start

The server will now start even without database connection, but will log warnings. Database-dependent features won't work until connection is established.

Check logs for:
- Port already in use
- Missing environment variables
- Permission issues

## Production Checklist

Before going to production:

- [ ] Set strong `DB_PASSWORD` (Railway auto-generates)
- [ ] Set `AUTH_JWT_SECRET` (64-char random hex)
- [ ] Set `KEY_ENCRYPTION_SECRET` (64-char random hex)
- [ ] Configure `PDS_HOSTNAME` and `PDS_SERVICE_URL`
- [ ] Set `PLC_DIRECTORY_URL` to your PLC service URL
- [ ] Set `CORS_ORIGINS` to your Web UI URL
- [ ] Verify database schema auto-initialized (check logs)
- [ ] Set up bootstrap admin and verify login
- [ ] Set up SSL/TLS certificates (Railway provides free SSL)
- [ ] Set up monitoring and alerting
- [ ] Configure backups for PostgreSQL
- [ ] Remove `BOOTSTRAP_ADMIN_*` variables after first login
- [ ] Create partner API keys for third-party integrations (if needed)
- [ ] Configure `PARTNER_API_ENABLED=true` and `PARTNER_DEFAULT_RATE_LIMIT` (if using partner registration)

## Monitoring

### Application Logs
```bash
# Docker
docker logs -f openfed-pds

# Railway
railway logs
```

### Database Logs
```bash
# Docker
docker logs -f openfed-postgres

# Railway
railway logs -s postgres
```

### Metrics to Monitor
- Database connection pool usage
- API response times
- Error rates
- Memory usage
- CPU usage
- Disk space (especially for repository blocks)
