# Phase 8: Deployment Strategy
# OpenFederation Web Management Interface

## Project Information
- **Project ID**: PROJ_OPENFEDERATION_WEB_001
- **Phase**: 08_deployment
- **Generated**: 2025-02-06T00:00:00Z

---

## Deployment Overview

- **Primary**: Docker Compose (self-hosted)
- **Cloud**: Railway (PaaS)
- **Future**: Kubernetes (Phase 3)

---

## Docker Compose Deployment (Self-Hosted)

### File Structure
```
openfederation-pds/
├── docker-compose.yml
├── Dockerfile (PDS server)
├── web-interface/
│   ├── Dockerfile
│   ├── package.json
│   └── ...
└── .env.example
```

### docker-compose.yml
```yaml
version: '3.8'

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: openfederation_pds
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  pds:
    build: .
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      NODE_ENV: production
      PORT: 3000
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: openfederation_pds
      DB_USER: postgres
      DB_PASSWORD: ${DB_PASSWORD}
      PDS_HOSTNAME: ${PDS_HOSTNAME}
      AUTH_JWT_SECRET: ${AUTH_JWT_SECRET}
      INVITE_REQUIRED: ${INVITE_REQUIRED}
    ports:
      - "3000:3000"
    volumes:
      - pds-data:/app/data
    restart: unless-stopped

  web:
    build: ./web-interface
    depends_on:
      - pds
    environment:
      NEXT_PUBLIC_PDS_URL: http://pds:3000
      NEXT_PUBLIC_APP_NAME: OpenFederation PDS
    ports:
      - "3001:3000"
    restart: unless-stopped

volumes:
  pgdata:
  pds-data:
```

### .env.example
```bash
# Database
DB_PASSWORD=change-me-in-production

# PDS Server
PDS_HOSTNAME=pds.openfederation.net
AUTH_JWT_SECRET=change-me-in-production-use-strong-random
INVITE_REQUIRED=true

# Optional
SENDGRID_API_KEY=your-sendgrid-key
```

### Deployment Commands
```bash
# Clone repository
git clone https://github.com/yourusername/openfederation-pds
cd openfederation-pds

# Copy environment file
cp .env.example .env

# Edit .env with your values
nano .env

# Build and start services
docker-compose up -d

# Check logs
docker-compose logs -f

# Access services
# PDS: http://localhost:3000
# Web Interface: http://localhost:3001
```

---

## Railway Deployment (Cloud PaaS)

### Step 1: Create Railway Project
1. Sign up at https://railway.app
2. Create new project
3. Add PostgreSQL database service

### Step 2: Deploy PDS Server
```bash
# Link to Railway
railway link

# Deploy PDS server
railway up

# Set environment variables
railway variables set PDS_HOSTNAME=your-pds.up.railway.app
railway variables set AUTH_JWT_SECRET=$(openssl rand -base64 32)
railway variables set INVITE_REQUIRED=true
```

### Step 3: Deploy Web Interface
```bash
cd web-interface

# Create separate Railway service
railway link

# Set environment variables
railway variables set NEXT_PUBLIC_PDS_URL=https://your-pds.up.railway.app

# Deploy
railway up
```

### Railway Configuration Files

#### railway.toml (PDS Server)
```toml
[build]
builder = "NIXPACKS"

[deploy]
startCommand = "npm start"
healthcheckPath = "/"
healthcheckTimeout = 100
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
```

#### railway.toml (Web Interface)
```toml
[build]
builder = "NIXPACKS"

[deploy]
startCommand = "npm start"
healthcheckPath = "/"
healthcheckTimeout = 100
```

---

## Environment Variables

### PDS Server (.env)
```bash
# Required
NODE_ENV=production
PORT=3000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=openfederation_pds
DB_USER=postgres
DB_PASSWORD=strong-password
PDS_HOSTNAME=pds.openfederation.net
AUTH_JWT_SECRET=strong-random-secret-at-least-32-chars
INVITE_REQUIRED=true

# Optional (Phase 2)
SENDGRID_API_KEY=SG.xxx
AWS_S3_BUCKET=openfederation-media
AWS_ACCESS_KEY_ID=xxx
AWS_SECRET_ACCESS_KEY=xxx
```

### Web Interface (.env.local)
```bash
# Required
NEXT_PUBLIC_PDS_URL=http://localhost:3000

# Optional
NEXT_PUBLIC_APP_NAME=OpenFederation PDS
```

---

## Database Migrations

### Initial Setup
```bash
# Run migrations
npm run migrate

# Create admin user (manual)
psql $DATABASE_URL -c "
INSERT INTO users (id, did, handle, email, password_hash, status, role)
VALUES (
  uuid_generate_v4(),
  'did:plc:admin123',
  'admin',
  'admin@yourdomain.com',
  '$2b$12$hashed_password',
  'approved',
  'admin'
);
"
```

### Backup Strategy
```bash
# Daily backup (cron job)
0 2 * * * pg_dump $DATABASE_URL | gzip > /backups/db_$(date +\%Y\%m\%d).sql.gz

# Retention: Keep last 30 days
find /backups -name "db_*.sql.gz" -mtime +30 -delete
```

---

## Monitoring & Logging

### Health Checks
```bash
# PDS Server
curl http://localhost:3000/xrpc/com.atproto.server.getSession

# Web Interface
curl http://localhost:3001
```

### Log Aggregation (Phase 2)
- Docker logs: `docker-compose logs -f`
- Railway logs: Built-in Railway dashboard
- Future: Winston + Loki + Grafana

---

## SSL/TLS Configuration

### Self-Hosted (Nginx + Let's Encrypt)
```nginx
# /etc/nginx/sites-available/openfederation
server {
    listen 80;
    server_name pds.openfederation.net;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name pds.openfederation.net;

    ssl_certificate /etc/letsencrypt/live/pds.openfederation.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pds.openfederation.net/privkey.pem;

    location / {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /xrpc/ {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Railway (Automatic HTTPS)
Railway provides automatic HTTPS certificates.

---

## Performance Optimization

### Production Build
```bash
# PDS Server
npm run build
NODE_ENV=production npm start

# Web Interface
npm run build
npm start
```

### Caching Strategy
- Static assets: CDN (Cloudflare)
- API responses: Redis cache (Phase 2)
- Database: Connection pooling

### Resource Limits
- **PDS Server**: 512MB RAM minimum, 1GB recommended
- **Web Interface**: 256MB RAM minimum, 512MB recommended
- **PostgreSQL**: 1GB RAM minimum, 2GB+ recommended

---

## Security Checklist

- [x] HTTPS enabled
- [x] Environment variables secured
- [x] Database password strong
- [x] JWT secret strong (32+ chars)
- [x] CORS configured
- [x] Rate limiting enabled
- [x] Regular backups configured
- [x] Firewall rules set
- [ ] Intrusion detection (Phase 2)
- [ ] Security headers (Phase 2)

---

## Rollback Strategy

### Docker Compose
```bash
# Rollback to previous version
docker-compose down
git checkout previous-tag
docker-compose up -d --build
```

### Railway
```bash
# Rollback via Railway dashboard
# Or redeploy previous commit
railway up --detach <commit-hash>
```

---

## Scaling Strategy (Phase 3)

### Horizontal Scaling
- Multiple PDS instances behind load balancer
- PostgreSQL read replicas
- Redis for distributed caching

### Kubernetes Deployment
- Helm chart for easy deployment
- Auto-scaling based on CPU/memory
- Rolling updates with zero downtime

---

## Deployment Checklist

### Pre-Deployment
- [ ] Environment variables configured
- [ ] Database migrations tested
- [ ] SSL certificate obtained
- [ ] Backup strategy configured
- [ ] Admin user created
- [ ] Health checks verified

### Post-Deployment
- [ ] Services running
- [ ] Database connected
- [ ] Authentication working
- [ ] Community creation working
- [ ] Admin dashboard accessible
- [ ] Logs being collected
- [ ] Monitoring active
- [ ] Backups scheduled

---

## Troubleshooting

### Common Issues

**Database connection failed**
- Check DATABASE_URL environment variable
- Verify PostgreSQL is running
- Check network connectivity

**JWT token errors**
- Verify AUTH_JWT_SECRET is set
- Check token expiration
- Ensure secret matches between services

**Community creation fails**
- Check user status is 'approved'
- Verify handle is unique
- Check DID generation service

---

## Cost Estimates

### Self-Hosted (VPS)
- DigitalOcean Droplet (2GB RAM): $18/month
- Domain + SSL: $15/year
- **Total**: ~$20/month

### Railway
- Free tier: Limited hours
- Hobby: $5/month
- Pro: $20/month
- **Total**: $5-20/month

---

## Documentation Links

- Docker: https://docs.docker.com
- Railway: https://docs.railway.app
- PostgreSQL: https://www.postgresql.org/docs
- Next.js: https://nextjs.org/docs/deployment

