FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node server.mjs torrent.mjs public-movies.mjs jackett.mjs stream-format.mjs torbox.mjs ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV BIND=0.0.0.0 PORT=7000 CATALOG=/catalog/catalog.json
EXPOSE 7000
CMD ["node", "server.mjs"]
