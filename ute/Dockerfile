# Node.js comes from the official image instead of Alpine's nodejs package:
# Alpine 3.24 still ships 24.18.1, without the 2026-10-20 security fixes.
FROM node:26.13.0-alpine3.24@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS node

FROM ghcr.io/home-assistant/base:latest

ARG BUILD_ARCH
ARG BUILD_VERSION

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}"

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=0

RUN apk add --no-cache \
    chromium \
    harfbuzz \
    nss \
    freetype \
    ttf-freefont \
    libstdc++ \
    libatomic

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && test "$(node --version)" = "v24.22.1" \
  && npm --version

WORKDIR /app

COPY app/package.json app/package-lock.json /app/
RUN npm ci --omit=dev

COPY app /app
COPY run.sh /run.sh

RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
