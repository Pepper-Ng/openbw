FROM nginx:alpine

LABEL org.opencontainers.image.source="https://github.com/Pepper-Ng/openbw"

COPY _site/ /usr/share/nginx/html/