#!/bin/sh
# Run once to obtain the initial SSL certificate
# Prerequisites: DNS A record for pfontology.intellectaipf.com pointing to this server's IP
set -e

DOMAIN="pfontology.intellectaipf.com"
EMAIL="${1:?Usage: ./init-ssl.sh your@email.com}"

# Step 1: Temporarily serve HTTP-only so certbot can verify
cat > /tmp/nginx-http-only.conf <<'EOF'
server {
    listen 80;
    server_name pfontology.intellectaipf.com;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 200 'waiting for cert'; }
}
EOF

docker compose run --rm -v /tmp/nginx-http-only.conf:/etc/nginx/conf.d/default.conf:ro nginx true 2>/dev/null || true

# Start nginx with HTTP-only config for ACME challenge
cp nginx/default.conf /tmp/nginx-ssl-backup.conf
cp /tmp/nginx-http-only.conf nginx/default.conf
docker compose up -d nginx

# Step 2: Request certificate
docker compose run --rm certbot certonly \
  --webroot -w /var/www/certbot \
  -d "$DOMAIN" \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email

# Step 3: Restore full SSL config and restart
cp /tmp/nginx-ssl-backup.conf nginx/default.conf
docker compose restart nginx

echo "✅ SSL certificate obtained for $DOMAIN"
echo "Run 'docker compose up -d' to start everything"
