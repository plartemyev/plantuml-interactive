# plantuml-interactive — single self-sufficient image.
# Serves the static page (darkhttpd on :8080) AND carries the full PCB
# routing toolchain (Node, KiCad pcbnew, Java >= 25 + the Freerouting jar),
# so diagrams can be re-routed inside this very image — no host toolchain:
#
#   docker compose up --build -d                          # serve
#   docker compose --profile route run --rm router --force # re-route
#   PUML_UPLOAD=1 docker compose up --build -d             # serve + uploads
#
# Everything lives in one tree at /app: darkhttpd's docroot is also the
# routing root (tools/route-board.mjs resolves paths relative to itself).
FROM archlinux:latest

# fontconfig: java's headless AWT (freerouting batch mode) wants libfontconfig
RUN pacman -Sy --noconfirm --needed darkhttpd nodejs python kicad jdk25-openjdk fontconfig && \
    rm -rf /var/cache/pacman/pkg /var/lib/pacman/sync/*

ENV HOME=/tmp
# matches EXPOSE for both server modes (darkhttpd gets --port 8080 explicitly)
ENV PORT=8080
COPY index.html package.json /app/
COPY css/ /app/css/
COPY js/ /app/js/
COPY tools/ /app/tools/
COPY tools/vendor/freerouting.jar /app/tools/vendor/freerouting.jar
COPY server/ /app/server/
COPY diagrams/ /app/diagrams/
COPY samples/ /app/samples/
# COPY preserves source metadata; checkouts with a tight umask (0600 files)
# would 403 for the unprivileged server user. .tmp/board is the router's
# scratch dir, .tmp/uploads the upload feature's, both pre-created writable
# for non-root runs (compose services).
RUN chmod -R a+rX /app && \
    mkdir -p /app/.tmp/board /app/.tmp/uploads && \
    chmod 777 /app/.tmp/board /app/.tmp/uploads

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD curl -fsS http://127.0.0.1:8080/diagrams/index.json >/dev/null || exit 1
WORKDIR /app
# PUML_UPLOAD=1 swaps darkhttpd for the node server (same page + the upload
# API and progress websocket); unset keeps the plain static server.
CMD ["/bin/sh", "-ec", "case \"$PUML_UPLOAD\" in 1|true|yes|on) exec /usr/bin/node /app/server/upload-server.mjs ;; *) exec /usr/bin/darkhttpd /app --addr 0.0.0.0 --port 8080 ;; esac"]
