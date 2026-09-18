FROM node:24-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app

COPY package.json ./
COPY vendor ./vendor
RUN npm install --no-audit --no-fund

COPY main.ts admin.ts drizzle.config.ts schema.ts tsconfig.json ./
COPY telegram-channel ./telegram-channel

CMD ["node", "main.ts"]
