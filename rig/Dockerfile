# rine-herdr rig: Ubuntu 24.04 by digest, node 24 copied from the pinned node image (the fleet cell's digest),
# herdr pinned by version and sha256. Everything runs as the invoking uid; all state lives on /work/scratch (tmpfs).
FROM node@sha256:c2d5ade763cacfb03fe9cb8e8af5d1be5041ff331921fa26a9b231ca3a4f780a AS node

FROM ubuntu:24.04@sha256:786a8b558f7be160c6c8c4a54f9a57274f3b4fb1491cf65146521ae77ff1dc54

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git python3 libstdc++6 procps \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version && npm --version

ARG HERDR_VERSION=0.9.5
ARG HERDR_SHA256_AMD64=14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d
ARG HERDR_SHA256_ARM64=17d7536f2da50859523680ef279dffcac8e4a235f4e46fe8da6c2ec44141897c
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) asset=herdr-linux-x86_64; sum="$HERDR_SHA256_AMD64" ;; \
      arm64) asset=herdr-linux-aarch64; sum="$HERDR_SHA256_ARM64" ;; \
      *) echo "unsupported arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /usr/local/bin/herdr "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/${asset}"; \
    echo "${sum}  /usr/local/bin/herdr" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/herdr; \
    herdr --version

ENV HOME=/work/scratch/home \
    NPM_CONFIG_PREFIX=/work/scratch/npm-global \
    PATH=/work/scratch/npm-global/bin:/usr/local/bin:/usr/bin:/bin \
    HERDR_PROCESS_DETECTION=child-groups \
    LANG=C.UTF-8
WORKDIR /work/scratch
