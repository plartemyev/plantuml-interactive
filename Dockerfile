# plantuml-interactive — single self-sufficient image.
# Serves the static page (darkhttpd on :8080) AND carries the full PCB
# routing toolchain (Node, KiCad pcbnew, Java >= 25 + the Freerouting jar),
# so diagrams can be re-routed inside this very image — no host toolchain:
#
#   docker compose up --build -d                          # serve
#   docker compose --profile route run --rm router --force # re-route
#
# Everything lives in one tree at /app: darkhttpd's docroot is also the
# routing root (tools/route-board.mjs resolves paths relative to itself).
FROM archlinux:latest

# fontconfig: java's headless AWT (freerouting batch mode) wants libfontconfig
RUN pacman -Sy --noconfirm --needed darkhttpd nodejs python kicad jdk25-openjdk fontconfig && \
    rm -rf /var/cache/pacman/pkg /var/lib/pacman/sync/*

ENV HOME=/tmp
COPY index.html package.json /app/
COPY css/ /app/css/
COPY js/ /app/js/
COPY tools/ /app/tools/
COPY tools/vendor/freerouting.jar /app/tools/vendor/freerouting.jar
COPY diagrams/ /app/diagrams/
COPY samples/ /app/samples/
# COPY preserves source metadata; checkouts with a tight umask (0600 files)
# would 403 for the unprivileged server user. .tmp/board is the router's
# scratch dir, pre-created writable for the host-uid router runs (compose).
RUN chmod -R a+rX /app && mkdir -p /app/.tmp/board && chmod 777 /app/.tmp/board

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD curl -fsS http://127.0.0.1:8080/diagrams/index.json >/dev/null || exit 1
WORKDIR /app
CMD ["/usr/bin/darkhttpd", "/app", "--addr", "0.0.0.0", "--port", "8080"]
