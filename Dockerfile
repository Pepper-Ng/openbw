FROM debian:bookworm-slim AS wasm-build

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates curl tar \
	&& rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/wasi-sdk \
	&& curl -fsSL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-33/wasi-sdk-33.0-x86_64-linux.tar.gz \
	| tar -xz --strip-components=1 -C /opt/wasi-sdk

WORKDIR /src
COPY . .
ENV WASI_SDK=/opt/wasi-sdk

RUN bash web/build-wasm.sh \
	&& CAMPAIGN_PACK=1 bash web/build-wasm.sh \
	&& mkdir -p /site/vendor \
	&& cp web/index.html web/manifest.webmanifest web/openbw.js web/net.js web/campaign-saves.js web/openbw.wasm /site/ \
	&& mkdir -p /site/debug && cp web/debug/index.html /site/debug/ \
	&& cp web/vendor/lucide.min.js web/vendor/lucide-LICENSE /site/vendor/ \
	&& if compgen -G "web/maps/*.scx" > /dev/null; then mkdir -p /site/maps && cp web/maps/*.scx /site/maps/; fi \
	&& build_id="$(date -u +%Y%m%d%H%M%S)" \
	&& sed -i "s/__BUILD__/${build_id}/g" /site/index.html /site/openbw.js

FROM node:22-alpine AS signalling
WORKDIR /app
COPY web/signalling-server.mjs ./
USER node
ENV PORT=8080
CMD ["node", "signalling-server.mjs"]

FROM nginx:alpine
RUN apk add --no-cache nodejs
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=wasm-build /site/ /usr/share/nginx/html/
COPY --from=wasm-build /src/web/campaign-pack.wasm /src/web/prepare-campaign.mjs /src/web/prepare-campaigns.mjs /opt/openbw/web/
CMD ["sh", "-c", "node /opt/openbw/web/prepare-campaigns.mjs && exec nginx -g 'daemon off;'"]