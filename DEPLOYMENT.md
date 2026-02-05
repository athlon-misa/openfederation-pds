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

# PLC Directory (Optional - uses default if not set)
PLC_DIRECTORY_URL=https://plc.directory   # PLC directory URL

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

1. **Create a new project on Railway**
2. **Add PostgreSQL database** (Railway will auto-configure connection variables)
3. **Deploy from GitHub:**
   - Connect your GitHub repository
   - Railway will auto-detect the Node.js app
4. **Set environment variables:**
   - `PDS_HOSTNAME`: Your Railway domain
   - `PDS_SERVICE_URL`: `https://your-app.railway.app`
   - `HANDLE_SUFFIX`: `.openfederation.net`

Railway automatically sets these (use Railway's provided values):
- `DATABASE_URL` (Railway format)
- `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`

5. **Initialize database:**
```bash
railway run psql $DATABASE_URL -f src/db/schema.sql
```

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

If you see errors about missing tables:

```bash
# Initialize the schema
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

- [ ] Set strong `DB_PASSWORD`
- [ ] Configure proper `PDS_HOSTNAME` and `PDS_SERVICE_URL`
- [ ] Initialize database schema
- [ ] Set up SSL/TLS certificates
- [ ] Configure reverse proxy (nginx/Caddy)
- [ ] Set up monitoring and alerting
- [ ] Configure backups for PostgreSQL
- [ ] Review security settings
- [ ] Implement rate limiting (TODO in code)
- [ ] Encrypt recovery keys at rest (TODO in code)
- [ ] Integrate with real PLC directory (TODO in code)

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
