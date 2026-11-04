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
	&& mkdir -p /site/vendor \
	&& cp web/index.html web/openbw.js web/net.js web/openbw.wasm /site/ \
	&& cp web/vendor/lucide.min.js web/vendor/lucide-LICENSE /site/vendor/ \
	&& if compgen -G "web/maps/*.scx" > /dev/null; then mkdir -p /site/maps && cp web/maps/*.scx /site/maps/; fi \
	&& build_id="$(date -u +%Y%m%d%H%M%S)" \
	&& sed -i "s/__BUILD__/${build_id}/g" /site/index.html /site/openbw.js

FROM nginx:alpine
COPY --from=wasm-build /site/ /usr/share/nginx/html/