FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

RUN addgroup -g 1001 -S livewave && adduser -S livewave -u 1001 -G livewave
RUN apk add --no-cache curl ffmpeg

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server/ server/
COPY public/ public/
COPY LICENSE LICENSES.md ./

RUN mkdir -p /app/data /app/recordings && chown -R livewave:livewave /app

USER livewave

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/livewave.db
ENV RECORDINGS_DIR=/app/recordings

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/rooms || exit 1

CMD ["node", "server/index.js"]
