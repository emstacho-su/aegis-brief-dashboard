# AEGIS brief worker. Build from the repository root:
#   docker build -f services/worker/Dockerfile -t aegis-worker .
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    VOLUME_ROOT=/var/lib/aegis/volume \
    MAX_BRIEFS=30 \
    PORT=8080 \
    WEB_ROOT=/app/web \
    SEED_DIR=/app/data/briefs

RUN groupadd --system --gid 10001 aegis \
 && useradd --system --uid 10001 --gid aegis --home-dir /app --shell /usr/sbin/nologin aegis

# Install the package. The shared contract files are copied into aegis_worker/_shared
# so the installed package carries them (see aegis_worker/shared.py).
COPY services/worker/pyproject.toml services/worker/README.md /tmp/build/
COPY services/worker/aegis_worker /tmp/build/aegis_worker
COPY packages/brief.schema.json packages/areas.json /tmp/build/aegis_worker/_shared/
RUN pip install /tmp/build && rm -rf /tmp/build

# Dashboard page served at /, and the sample briefs used to seed an empty volume.
COPY apps/web/dashboard.html /app/web/dashboard.html
COPY data/briefs /app/data/briefs
COPY --chmod=0755 services/worker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /var/lib/aegis/volume && chown -R aegis:aegis /var/lib/aegis
USER aegis
WORKDIR /app
VOLUME ["/var/lib/aegis/volume"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT','8080'), timeout=4)" || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["aegis-worker", "serve"]
