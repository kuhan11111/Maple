FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional
COPY src ./src
COPY data/templates ./data/templates
RUN mkdir -p data music && chown -R node:node /app
USER node
VOLUME ["/app/data", "/app/music"]
CMD ["node", "src/bot.js"]
