# Railway.app Deployment Guide

## Quick Deploy (5 minutes)

### 1. Prerequisites
- Railway account (https://railway.app)
- GitHub repository connected to Railway

### 2. Deploy Steps

#### Step 1: Create New Project
```bash
# Via Railway CLI (or use Railway Dashboard)
railway login
railway init
```

#### Step 2: Add PostgreSQL Database
In Railway Dashboard:
1. Click "New" → "Database" → "Add PostgreSQL"
2. Railway automatically sets: `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`

#### Step 3: Configure Environment Variables
In Railway Dashboard → Variables, add:

```bash
# Required
PDS_HOSTNAME=your-app-name.up.railway.app
PDS_SERVICE_URL=https://your-app-name.up.railway.app

# Optional (only if changing defaults)
HANDLE_SUFFIX=.your-domain.com
PLC_DIRECTORY_URL=https://plc.directory
```

**Note:** Railway automatically sets `PORT` and all database variables.

#### Step 4: Deploy
```bash
# Push to GitHub (Railway auto-deploys)
git push origin main

# Or deploy directly
railway up
```

#### Step 5: Initialize Database Schema
```bash
railway run psql $DATABASE_URL -f src/db/schema.sql
```

### 3. Verify Deployment

```bash
# Check health
curl https://your-app-name.up.railway.app/health

# Expected response
{
  "status": "ok",
  "database": "connected",
  "timestamp": "2026-02-05T..."
}
```

### 4. Test Community Creation

```bash
curl -X POST https://your-app-name.up.railway.app/xrpc/net.openfederation.community.create \
  -H "Content-Type: application/json" \
  -d '{
    "handle": "test-community",
    "didMethod": "plc",
    "displayName": "Test Community"
  }'
```

## Troubleshooting

### Database Connection Failed
- Ensure PostgreSQL service is running in Railway
- Check that database environment variables are set (Railway should auto-set)
- Verify database schema is initialized

### Build Failed
- Check Railway build logs
- Ensure Node.js version >=18
- Verify all dependencies in package.json

### App Crashes on Start
- Check Railway deployment logs
- Ensure PORT is not hardcoded (use process.env.PORT)
- Verify environment variables are set

## Railway CLI Commands

```bash
# View logs
railway logs

# Connect to PostgreSQL
railway connect postgres

# Run commands in Railway environment
railway run <command>

# Open dashboard
railway open
```

## Monitoring

Railway provides built-in monitoring:
- **Metrics:** CPU, Memory, Network usage
- **Logs:** Real-time application logs
- **Health Checks:** Automatic based on `/health` endpoint

## Custom Domain (Optional)

1. Go to Railway Dashboard → Settings → Domains
2. Click "Generate Domain" or "Add Custom Domain"
3. Update environment variables:
   ```
   PDS_HOSTNAME=your-domain.com
   PDS_SERVICE_URL=https://your-domain.com
   ```
4. Configure DNS (if custom domain):
   - Add CNAME record pointing to Railway

## Cost Estimates

Railway Pricing (as of 2026):
- **Hobby Plan:** $5/month + usage
  - PostgreSQL included
  - 500 hours execution time
  - 100GB bandwidth

- **Usage Costs:**
  - Compute: ~$0.000463/minute
  - Storage: ~$0.25/GB/month

For OpenFederation PDS (light usage):
- Estimated: $5-15/month

## Production Checklist

Before going production:
- [ ] Set strong database password (Railway auto-generates)
- [ ] Configure custom domain
- [ ] Set up SSL certificate (Railway provides free SSL)
- [ ] Enable deployment notifications
- [ ] Set up monitoring alerts
- [ ] Configure backup strategy for PostgreSQL
- [ ] Review security settings
- [ ] Test all endpoints

## Support

- Railway Docs: https://docs.railway.app
- Railway Discord: https://discord.gg/railway
- OpenFederation Issues: https://github.com/athlon-misa/openfederation-pds/issues
