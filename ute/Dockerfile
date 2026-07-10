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
    nodejs \
    npm

WORKDIR /app

COPY app/package.json app/package-lock.json /app/
RUN npm ci --omit=dev

COPY app /app
COPY run.sh /run.sh

RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
