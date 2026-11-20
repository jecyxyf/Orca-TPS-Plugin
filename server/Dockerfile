FROM node:24-bookworm-slim

WORKDIR /app
COPY server/*.mjs ./server/
COPY src/*.mjs ./src/
COPY src/locales/*.xml ./src/locales/
RUN install -d -o node -g node -m 0700 /data

USER node
CMD ["node", "server/main.mjs"]
