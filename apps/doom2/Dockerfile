# Zandronum Doom 2 server with a Respawn shim that injects sv_rconpassword from a
# secret (kept off the command line) and bakes in freedoom2.wad so the server is
# self-contained — no manual wad upload needed. A retail /data/doom2.wad on the
# EFS volume overrides freedoom at runtime. Build context is the repo root.
FROM rcdailey/zandronum-server:official-latest

# freedoom2.wad is freely redistributable (BSD-like license). Pinned release.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates unzip \
  && curl -sL -o /tmp/freedoom.zip \
       https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip \
  && unzip -o -j /tmp/freedoom.zip "*/freedoom2.wad" -d / \
  && rm -f /tmp/freedoom.zip \
  && apt-get purge -y curl unzip && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

COPY apps/doom2/respawn-init.sh /respawn-init.sh
RUN chmod +x /respawn-init.sh

ENTRYPOINT ["/respawn-init.sh"]
