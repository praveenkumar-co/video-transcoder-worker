FROM node:20-alpine

RUN apk add --no-cache ffmpeg ca-certificates && update-ca-certificates

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

CMD ["node", "--max-old-space-size=1024", "dist/worker.js"]
