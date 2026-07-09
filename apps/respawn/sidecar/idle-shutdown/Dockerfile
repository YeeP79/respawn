FROM alpine:3.21

RUN apk add --no-cache \
    bash \
    curl \
    jq \
    iproute2 \
    aws-cli \
    python3

COPY watchdog.sh /usr/local/bin/watchdog.sh
COPY players.py /usr/local/bin/players.py
RUN chmod +x /usr/local/bin/watchdog.sh /usr/local/bin/players.py

ENTRYPOINT ["/usr/local/bin/watchdog.sh"]
