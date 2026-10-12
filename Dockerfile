##
# Send
#
# License https://gitlab.com/timvisee/send/blob/master/LICENSE
##

# Build project
FROM node:16.13-alpine3.13 AS builder

RUN set -x \
  # Change node uid/gid
  && apk --no-cache add shadow \
  && groupmod -g 1001 node \
  && usermod -u 1001 -g 1001 node

RUN set -x \
    # Add user
    && addgroup --gid 1000 app \
    && adduser --disabled-password \
        --gecos '' \
        --ingroup app \
        --home /app \
        --uid 1000 \
        app

COPY --chown=app:app . /app

USER app
WORKDIR /app

RUN set -x \
    # Build
    && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm ci \
    && npm run build

# Main image
FROM node:16.13-alpine3.13

RUN set -x \
  # Change node uid/gid
  && apk --no-cache add shadow \
  && groupmod -g 1001 node \
  && usermod -u 1001 -g 1001 node

RUN set -x \
    # Add user
    && addgroup --gid 1000 app \
    && adduser --disabled-password \
        --gecos '' \
        --ingroup app \
        --home /app \
        --uid 1000 \
        app

USER app
WORKDIR /app

COPY --chown=app:app package*.json ./
COPY --chown=app:app app app
COPY --chown=app:app common common
COPY --chown=app:app public/locales public/locales
COPY --chown=app:app server server
COPY --chown=app:app --from=builder /app/dist dist

RUN npm ci --production && npm cache clean --force
RUN mkdir -p /app/.config/configstore
RUN mkdir -p /app/admin-data
RUN ln -s dist/version.json version.json

ENV PORT=1443

# Admin data (credentials JSON) must be persisted: mount a volume here
VOLUME /app/admin-data

# 1443: public app, 2526: LAN-only admin UI
EXPOSE ${PORT} 2526

CMD ["node", "server/bin/prod.js"]
