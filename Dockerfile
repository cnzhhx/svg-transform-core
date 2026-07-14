FROM node:22.16.0-bookworm-slim AS base

ARG DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian
ARG DEBIAN_SECURITY_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian-security
ARG NPM_REGISTRY=https://registry.npmmirror.com

ENV PNPM_HOME=/usr/local/share/pnpm \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    CHROMIUM_PATH=/usr/local/bin/chromium-playwright \
    NODE_ENV=production \
    PORT=4310 \
    WORKSPACE=/app/workspace \
    MODEL_PROVIDER_CONFIG=/app/config/model-provider.json \
    NPM_CONFIG_REGISTRY=${NPM_REGISTRY} \
    OPENCODE_CLI_PATH=opencode

ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable \
  && corepack prepare pnpm@10.11.0 --activate \
  && npm config set registry "${NPM_REGISTRY}" \
  && pnpm config set registry "${NPM_REGISTRY}" \
  && rm -f /etc/apt/sources.list.d/*.sources \
  && printf '%s\n' \
    "deb ${DEBIAN_MIRROR} bookworm main contrib non-free non-free-firmware" \
    "deb ${DEBIAN_MIRROR} bookworm-updates main contrib non-free non-free-firmware" \
    "deb ${DEBIAN_SECURITY_MIRROR} bookworm-security main contrib non-free non-free-firmware" \
    > /etc/apt/sources.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fontconfig \
    fonts-noto-cjk \
    git \
    procps \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY packages/client/package.json packages/client/package.json
RUN set -eux; \
  pnpm install --frozen-lockfile --prod=false; \
  pnpm -C apps/server exec playwright install --with-deps chromium; \
  chromium_bin="$(find /opt/ms-playwright -type f -path '*/chrome-linux*/chrome' -print -quit)"; \
  test -n "$chromium_bin"; \
  ln -sf "$chromium_bin" /usr/local/bin/chromium-playwright; \
  /usr/local/bin/chromium-playwright --version; \
  npm install -g opencode-ai@1.17.7; \
  npm cache clean --force; \
  pnpm store prune; \
  rm -rf /root/.npm /root/.cache/pnpm /tmp/*

COPY . .

RUN pnpm run build \
  && rm -rf /root/.npm /root/.cache/pnpm /tmp/* \
  && mkdir -p /app/workspace /app/config

ENV NODE_OPTIONS=--max-old-space-size=4096

EXPOSE 4310

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '4310') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["pnpm", "-C", "apps/server", "start"]
