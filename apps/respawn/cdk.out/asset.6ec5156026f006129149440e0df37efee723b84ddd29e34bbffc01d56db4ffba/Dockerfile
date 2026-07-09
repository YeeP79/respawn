FROM alpine:3.21

RUN apk add --no-cache \
    bash \
    curl \
    jq \
    iproute2 \
    aws-cli

COPY watchdog.sh /usr/local/bin/watchdog.sh
RUN chmod +x /usr/local/bin/watchdog.sh

ENTRYPOINT ["/usr/local/bin/watchdog.sh"]
