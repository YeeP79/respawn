#!/usr/bin/env python3
"""Print the number of human players on a game server.

The netstat check cannot see players on UDP games: they serve every client from a
single unconnected socket, so `ss -tun state established` never reports a peer and
an occupied server looks idle. Asking the game itself is the only reliable signal.

Protocols:
  a2s      Valve GoldSrc/Source (and Steam-hosted games: Rust, 7 Days to Die)
  q3       idTech3 `getstatus` (Quake 3, Quake Live)
  gamespy  Unreal Engine 1 `\\info\\` (Unreal Tournament 99)

Prints the human player count on stdout, or -1 when the server could not be
queried. -1 means "unknown", not "empty": the caller must hold its idle timer
rather than scale a populated server to zero because one packet dropped. Every
failure path here therefore returns -1, never 0.
"""

import argparse
import socket
import sys

A2S_INFO = b"\xff\xff\xff\xffTSource Engine Query\x00"
A2S_CHALLENGE = 0x41
A2S_SOURCE = 0x49
A2S_GOLDSRC = 0x6D

Q3_GETSTATUS = b"\xff\xff\xff\xffgetstatus\n"
GAMESPY_INFO = b"\\info\\"


# --- parsers (pure, unit-testable) -------------------------------------------


def parse_a2s(payload: bytes) -> int:
    """Parse an A2S_INFO body (after the 0xFFFFFFFF prefix). Bots excluded."""
    header = payload[0]

    if header == A2S_SOURCE:
        # protocol(1) name\0 map\0 folder\0 game\0 appid(2) players(1) max(1) bots(1)
        parts = payload[2:].split(b"\x00", 4)
        if len(parts) < 5 or len(parts[4]) < 5:
            raise ValueError("truncated Source response")
        players, bots = parts[4][2], parts[4][4]
        return max(0, players - bots)

    if header == A2S_GOLDSRC:
        # address\0 name\0 map\0 folder\0 game\0 players(1) max(1) protocol(1)
        parts = payload[1:].split(b"\x00", 5)
        if len(parts) < 6 or len(parts[5]) < 1:
            raise ValueError("truncated GoldSrc response")
        return parts[5][0]  # GoldSrc reports no bot count

    raise ValueError(f"unexpected A2S header 0x{header:02x}")


def _infostring(line: str) -> dict:
    """Parse an idTech `\\key\\value\\key\\value` infostring."""
    tokens = [t for t in line.split("\\") if t != ""]
    return dict(zip(tokens[0::2], tokens[1::2]))


def parse_q3(payload: bytes) -> int:
    """Parse an idTech3 statusResponse body (after the 0xFFFFFFFF prefix)."""
    text = payload.decode("latin-1")
    if not text.startswith("statusResponse"):
        raise ValueError("not a statusResponse")

    lines = text.split("\n")
    if len(lines) < 2:
        raise ValueError("truncated statusResponse")

    info = _infostring(lines[1])
    # ioquake3 reports humans separately when bots are present; prefer it.
    if "g_humanplayers" in info:
        return int(info["g_humanplayers"])

    # Otherwise each remaining non-empty line is one connected player.
    return len([ln for ln in lines[2:] if ln.strip()])


def parse_gamespy(payload: bytes) -> int:
    """Parse a GameSpy v1 `\\info\\` response."""
    info = _infostring(payload.decode("latin-1"))
    for key in ("numplayers", "numPlayers", "players"):
        if key in info:
            return int(info[key])
    raise ValueError("no numplayers field in gamespy response")


# --- transports ---------------------------------------------------------------


def _udp(host: str, port: int, payload: bytes, timeout: float) -> bytes:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(payload, (host, port))
        data, _ = sock.recvfrom(8192)
        return data
    finally:
        sock.close()


def query_a2s(host: str, port: int, timeout: float) -> int:
    data = _udp(host, port, A2S_INFO, timeout)
    # Newer builds answer with a challenge that must be echoed back.
    if len(data) >= 9 and data[4] == A2S_CHALLENGE:
        data = _udp(host, port, A2S_INFO + data[5:9], timeout)
    return parse_a2s(data[4:])


def query_q3(host: str, port: int, timeout: float) -> int:
    data = _udp(host, port, Q3_GETSTATUS, timeout)
    return parse_q3(data[4:])


def query_gamespy(host: str, port: int, timeout: float) -> int:
    return parse_gamespy(_udp(host, port, GAMESPY_INFO, timeout))


QUERIES = {"a2s": query_a2s, "q3": query_q3, "gamespy": query_gamespy}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--protocol", required=True, choices=sorted(QUERIES))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--timeout", type=float, default=4.0)
    args = ap.parse_args()

    try:
        print(QUERIES[args.protocol](args.host, args.port, args.timeout))
    except Exception as exc:  # noqa: BLE001 - any failure means "unknown"
        print(-1)
        print(f"{args.protocol} query failed: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
