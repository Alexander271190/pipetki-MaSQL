FROM node:20-alpine

# mysql-client (mariadb-client) — для mysqldump / mysql в routes/backup.js
RUN apk add --no-cache mariadb-client

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data/backups

EXPOSE 3000

CMD ["node", "server.js"]
