# Builds the SPA for /wolog/, then serves it with nginx (spec §8). The apps server's nginx strips
# the /wolog prefix before requests reach this container. It runs read-only, with tmpfs for
# nginx's writable paths (docker-compose.aws.yml).

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.28-alpine AS production
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/health || exit 1
