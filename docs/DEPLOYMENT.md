# Open Migration Stack - Deployment Guide

This guide covers deployment options for the Open Migration Stack, including local development, production, and various hosting scenarios.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local Development](#local-development)
3. [Docker Compose Deployment](#docker-compose-deployment)
4. [Production Deployment](#production-deployment)
5. [Environment Configuration](#environment-configuration)
6. [Monitoring & Logging](#monitoring--logging)
7. [Backup & Recovery](#backup--recovery)

---

## Prerequisites

- Docker and Docker Compose v2.0+
- Node.js 24+ (for local development)
- pnpm package manager
- Git
- PostgreSQL 15+ (for production deployments)

---

## Local Development

### Quick Start

1. **Clone the repository:**
```bash
git clone https://github.com/Robbes/open-migrate.git
cd open-migrate
```

2. **Set up environment variables:**
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. **Start the development stack:**
```bash
docker compose -f deploy/compose/dev.yml up -d
```

This starts:
- PostgreSQL database (port 5432)
- Trigger.dev (port 3090)
- API server (port 3001)
- Web application (port 3123)

4. **Access the applications:**
- Web UI: http://localhost:3123
- API: http://localhost:3001
- Trigger.dev Dashboard: http://localhost:3090

5. **Stop the stack:**
```bash
docker compose -f deploy/compose/dev.yml down
```

### Individual Service Development

For active development with hot reload:

```bash
# Start database only
docker compose up -d postgres trigger-db trigger-redis

# Install dependencies
pnpm install

# Start API with hot reload
cd apps/api
pnpm dev

# Start web app with hot reload
cd apps/web
pnpm dev

# Start worker
cd apps/worker
pnpm dev
```

---

## Docker Compose Deployment

### Production Docker Compose

1. **Copy the production environment file:**
```bash
cp .env.example .env
```

2. **Update environment variables:**
   - Set strong secrets for `JWT_SECRET`, `TRIGGER_ENCRYPTION_KEY`, etc.
   - Configure Mollie API keys
   - Set production URLs

3. **Start the production stack:**
```bash
docker compose up -d
```

4. **Check service status:**
```bash
docker compose ps
```

5. **View logs:**
```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f api
```

### Service Ports

| Service | Port | Description |
|---------|------|-------------|
| Web UI | 3123 | React web application |
| API | 3001 | Express REST API |
| PostgreSQL | 5432 | Primary database |
| Trigger.dev | 3090 | Job orchestration dashboard |
| Redis | 6379 | Trigger.dev cache/queue |

---

## Production Deployment

### Option 1: Docker Compose on VPS

**Requirements:**
- Ubuntu 20.04+ or Debian 11+
- 4GB RAM minimum (8GB recommended)
- 20GB disk space
- Domain name with SSL certificate

**Steps:**

1. **Install Docker:**
```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
```

2. **Install Docker Compose:**
```bash
sudo apt install docker-compose-plugin
```

3. **Clone and configure:**
```bash
git clone https://github.com/Robbes/open-migrate.git
cd open-migrate
cp .env.example .env
# Edit .env with production values
```

4. **Set up reverse proxy (nginx):**
```bash
sudo apt install nginx
sudo nano /etc/nginx/sites-available/open-migrate
```

Example nginx config:
```nginx
server {
    listen 80;
    server_name migrate.yourdomain.com;
    
    location / {
        proxy_pass http://localhost:3123;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

5. **Enable SSL with Let's Encrypt:**
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d migrate.yourdomain.com
```

6. **Start the stack:**
```bash
docker compose up -d
```

7. **Set up automatic updates:**
```bash
# Create update script
cat > /usr/local/bin/update-open-migrate.sh << 'EOF'
#!/bin/bash
cd /path/to/open-migrate
git pull
docker compose pull
docker compose up -d
docker system prune -f
EOF

chmod +x /usr/local/bin/update-open-migrate.sh

# Add to crontab (weekly on Sunday at 3 AM)
echo "0 3 * * 0 /usr/local/bin/update-open-migrate.sh" | sudo crontab -
```

### Option 2: Kubernetes Deployment

**Prerequisites:**
- Kubernetes cluster (1.25+)
- kubectl configured
- Helm 3.0+

**Steps:**

1. **Install Helm charts:**
```bash
cd deploy/helm
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
```

2. **Create namespace:**
```bash
kubectl create namespace open-migrate
```

3. **Install dependencies:**
```bash
helm install postgres bitnami/postgresql \
  --namespace open-migrate \
  --set auth.username=openmigrate \
  --set auth.password=openmigrate_password \
  --set auth.database=openmigrate

helm install redis bitnami/redis \
  --namespace open-migrate \
  --set auth.password=redis_password
```

4. **Deploy Open Migration:**
```bash
helm install open-migrate ./open-migrate \
  --namespace open-migrate \
  -f values-production.yaml
```

### Option 3: Cloud Provider Deployment

#### AWS ECS

1. **Create ECR repository:**
```bash
aws ecr create-repository --repository-name open-migrate-api
aws ecr create-repository --repository-name open-migrate-web
aws ecr create-repository --repository-name open-migrate-worker
```

2. **Build and push images:**
```bash
# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com

# Build and push
docker build -t <account-id>.dkr.ecr.us-east-1.amazonaws.com/open-migrate-api:latest -f apps/api/Dockerfile .
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/open-migrate-api:latest
```

3. **Create ECS cluster and services:**
```bash
aws ecs create-cluster --cluster-name open-migrate
# Follow AWS documentation for service creation
```

#### Google Cloud Run

1. **Build and push to Artifact Registry:**
```bash
gcloud auth configure-docker
docker build -t gcr.io/<project-id>/open-migrate-api -f apps/api/Dockerfile .
docker push gcr.io/<project-id>/open-migrate-api
```

2. **Deploy to Cloud Run:**
```bash
gcloud run deploy open-migrate-api \
  --image gcr.io/<project-id>/open-migrate-api \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars NODE_ENV=production
```

---

## Environment Configuration

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `POSTGRES_USER` | Database username | `openmigrate` |
| `POSTGRES_PASSWORD` | Database password | `secure-password` |
| `JWT_SECRET` | JWT signing secret | `random-string-32-chars` |
| `TRIGGER_ENCRYPTION_KEY` | Trigger.dev encryption key | `random-string-32-chars` |
| `MOLLIE_API_KEY` | Mollie payment API key | `live_xxx` |
| `WEB_URL` | Public web URL | `https://migrate.example.com` |
| `API_URL` | Public API URL | `https://api.example.com` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment | `development` |
| `CORS_ORIGIN` | CORS allowed origin | `http://localhost:3123` |
| `IMAP_TIMEOUT` | IMAP operation timeout | `300` |
| `JMAP_TIMEOUT` | JMAP operation timeout | `300` |

### Security Best Practices

1. **Never commit `.env` files**
2. **Use strong, unique secrets** for all encryption keys
3. **Enable HTTPS** in production
4. **Regularly update** Docker images and dependencies
5. **Use environment-specific** configurations
6. **Implement rate limiting** for API endpoints
7. **Enable database backups**

---

## Monitoring & Logging

### Application Logs

```bash
# View all logs
docker compose logs -f

# View API logs only
docker compose logs -f api

# View last 100 lines
docker compose logs --tail=100
```

### Health Checks

```bash
# API health
curl http://localhost:3001/health

# Database health
docker compose exec postgres pg_isready -U openmigrate
```

### Recommended Monitoring Stack

1. **Prometheus + Grafana** for metrics
2. **ELK Stack** (Elasticsearch, Logstash, Kibana) for logs
3. **Sentry** for error tracking

---

## Backup & Recovery

### Database Backup

```bash
# Create backup
docker compose exec postgres pg_dump -U openmigrate openmigrate > backup_$(date +%Y%m%d).sql

# Restore from backup
docker compose exec -T postgres psql -U openmigrate openmigrate < backup_20240101.sql
```

### Automated Backups

Create a backup script:

```bash
#!/bin/bash
# backup.sh

BACKUP_DIR="/backups/open-migrate"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR

# Database backup
docker compose exec -T postgres pg_dump -U openmigrate openmigrate | gzip > $BACKUP_DIR/db_$DATE.sql.gz

# Keep only last 7 days
find $BACKUP_DIR -name "*.sql.gz" -mtime +7 -delete
```

Set up cron job:
```bash
0 2 * * * /path/to/backup.sh
```

---

## Troubleshooting

### Common Issues

**Database connection errors:**
```bash
# Check if PostgreSQL is running
docker compose ps postgres

# Check database logs
docker compose logs postgres
```

**API not starting:**
```bash
# Check environment variables
docker compose exec api env

# Check API logs
docker compose logs api
```

**Web app not loading:**
```bash
# Check if API is accessible
curl http://localhost:3001/health

# Check web container logs
docker compose logs web
```

### Getting Help

- Check the [documentation](docs/)
- Review [troubleshooting guide](docs/troubleshooting.md)
- Open an issue on GitHub
- Check community forums

---

## Performance Optimization

### Database Optimization

```sql
-- Create indexes
CREATE INDEX idx_mappings_tenant_id ON mappings(tenant_id);
CREATE INDEX idx_migration_runs_mapping_id ON migration_runs(mapping_id);
CREATE INDEX idx_usage_metrics_tenant_period ON usage_metrics(tenant_id, period);
```

### Caching Strategy

1. Use Redis for session storage
2. Cache API responses with appropriate TTL
3. Implement CDN for static assets

---

## Upgrading

### From Previous Version

```bash
# Stop services
docker compose down

# Pull latest images
docker compose pull

# Run migrations
docker compose exec api npx drizzle-kit migrate

# Start services
docker compose up -d
```

---

## Support

For enterprise support and custom deployments, contact: support@openmigrate.io

---

*Last updated: 2024-01-15*
