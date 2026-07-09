#!/usr/bin/env python3
"""Print the number of human players on a Valve (GoldSrc/Source) game server.

The netstat check cannot see players on these games: a GoldSrc/Source server
serves every client from a single unconnected UDP socket, so `ss -tun state
established` never reports a peer and an occupied server looks idle. Asking the
game itself via A2S_INFO is the only reliable signal.

Prints the human player count (bots excluded) on stdout, or -1 when the server
could not be queried. -1 means "unknown", not "empty" — the caller must not treat
it as idle, or a query hiccup would scale a populated server to zero.
"""

import socket
import sys

A2S_INFO = b"\xff\xff\xff\xffTSource Engine Query\x00"
HEADER_CHALLENGE = 0x41
HEADER_SOURCE = 0x49
HEADER_GOLDSRC = 0x6D


def _humans(payload: bytes) -> int:
    """Parse an A2S_INFO response body (after the 4-byte 0xFFFFFFFF prefix)."""
    header = payload[0]

    if header == HEADER_SOURCE:
        # protocol(1) name\0 map\0 folder\0 game\0 appid(2) players(1) max(1) bots(1)
        rest = payload[2:]
        parts = rest.split(b"\x00", 4)
        if len(parts) < 5:
            raise ValueError("truncated Source response")
        tail = parts[4]
        if len(tail) < 5:
            raise ValueError("truncated Source counters")
        players, bots = tail[2], tail[4]
        return max(0, players - bots)

    if header == HEADER_GOLDSRC:
        # address\0 name\0 map\0 folder\0 game\0 players(1) max(1) protocol(1)
        parts = payload[1:].split(b"\x00", 5)
        if len(parts) < 6:
            raise ValueError("truncated GoldSrc response")
        tail = parts[5]
        if len(tail) < 1:
            raise ValueError("truncated GoldSrc counters")
        return tail[0]  # GoldSrc reports no bot count

    raise ValueError(f"unexpected A2S header 0x{header:02x}")


def query(host: str, port: int, timeout: float = 4.0) -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(A2S_INFO, (host, port))
        data, _ = sock.recvfrom(4096)

        # Newer builds answer with a challenge that must be echoed back.
        if len(data) >= 9 and data[4] == HEADER_CHALLENGE:
            sock.sendto(A2S_INFO + data[5:9], (host, port))
            data, _ = sock.recvfrom(4096)

        return _humans(data[4:])
    finally:
        sock.close()


def main() -> int:
    host = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 27015
    try:
        print(query(host, port))
    except Exception as exc:  # noqa: BLE001 - any failure means "unknown"
        print(-1)
        print(f"a2s query failed: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
