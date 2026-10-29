FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY data/templates ./data/templates
RUN mkdir -p data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
CMD ["node", "src/bot.js"]
