FROM mcr.microsoft.com/playwright:v1.64.1-noble

ENV NODE_ENV=production \
    HOME=/tmp \
    TMPDIR=/tmp \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /opt/preview-worker
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY worker.mjs worker.test.mjs ./
USER pwuser
# This watchdog survives a disconnected/killed host CLI and a blocked JS event loop.
ENTRYPOINT ["timeout", "--signal=KILL", "40s", "node", "worker.mjs"]
