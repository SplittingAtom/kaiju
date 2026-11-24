# Build from the repository root: docker build -f apps/web/Dockerfile .
# No `# syntax=` directive: dockerd's built-in frontend parses this file, so builds don't start
# the external docker/dockerfile frontend container (it crashed intermittently on CI runners:
# "frontend grpc server closed unexpectedly").
# Digest-pinned: Node 24.22.3; since 24.22.1 its root store lacks emSign ECC Root CA - G3 (KOBE-486).
ARG NODE_IMAGE=node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ARG PNPM_VERSION=12.8.1

FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
RUN pnpm fetch
COPY . .
# KOBE-487: the build id open tabs compare with /api/build (e.g. local-<sha12>); empty = a fresh
# random one per build. Declared after COPY so it never invalidates the dependency layers.
ARG KAIJU_BUILD_ID=""
ENV KAIJU_BUILD_ID=${KAIJU_BUILD_ID}
RUN pnpm install --offline --frozen-lockfile \
 && pnpm turbo run build --filter=@kaiju/web...

FROM ${NODE_IMAGE}
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
# Debian security fixes for the base image's own packages (apt, ...) before the pinned digest moves,
# so a fixed CVE does not fail publish's Trivy gate; npm, npx and corepack go too: the app runs with
# node only, and the bundled npm carried fixable HIGHs (undici, brace-expansion) (KOBE-539).
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
# Next.js needs a writable cache dir; everything else stays root-owned
RUN mkdir -p apps/web/.next/cache && chown 1000:1000 apps/web/.next/cache
# Kaiju's license, NOTICE and third-party inventory (Apache-2.0 section 4, KOBE-375).
COPY LICENSE NOTICE THIRD_PARTY_LICENSES.md /usr/share/doc/kaiju/
# The shipped fonts' licenses (SIL OFL 1.1, KOBE-555); the browser gets the fonts from .next/static.
COPY apps/web/app/fonts/outfit/OFL.txt /usr/share/doc/kaiju/fonts/outfit/OFL.txt
COPY apps/web/app/fonts/jetbrains-mono/OFL.txt /usr/share/doc/kaiju/fonts/jetbrains-mono/OFL.txt
# Files stay root-owned (read-only to the app); numeric non-root user so runAsNonRoot can verify it.
USER 1000:1000
EXPOSE 8080
CMD ["node", "apps/web/server.js"]
