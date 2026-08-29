#!/usr/bin/env python3
"""Minimal Source RCON client, for driving a local spike server.

Source RCON is TCP and authenticates once per connection, unlike GoldSrc which
carries the password in every packet — which is the structural reason S3 exists
as a question at all rather than being assumed to behave the same way.

Usage:  srcds-rcon.py <host> <port> <password> <command> [command ...]
"""
import socket
import struct
import sys

SERVERDATA_AUTH = 3
SERVERDATA_EXECCOMMAND = 2
SERVERDATA_AUTH_RESPONSE = 2


def _pack(req_id: int, kind: int, body: str) -> bytes:
    payload = struct.pack("<ii", req_id, kind) + body.encode("utf-8") + b"\x00\x00"
    return struct.pack("<i", len(payload)) + payload


def _read(sock: socket.socket) -> tuple[int, int, str]:
    raw = b""
    while len(raw) < 4:
        chunk = sock.recv(4 - len(raw))
        if not chunk:
            raise ConnectionError("closed while reading length")
        raw += chunk
    size = struct.unpack("<i", raw)[0]
    body = b""
    while len(body) < size:
        chunk = sock.recv(size - len(body))
        if not chunk:
            raise ConnectionError("closed while reading body")
        body += chunk
    req_id, kind = struct.unpack("<ii", body[:8])
    return req_id, kind, body[8:-2].decode("utf-8", "replace")


def main() -> int:
    host, port, password, *commands = sys.argv[1:]
    with socket.create_connection((host, int(port)), timeout=15) as sock:
        sock.sendall(_pack(1, SERVERDATA_AUTH, password))
        # The server answers auth with an empty RESPONSE_VALUE then the real
        # AUTH_RESPONSE; a request id of -1 means the password was rejected.
        while True:
            req_id, kind, _ = _read(sock)
            if kind == SERVERDATA_AUTH_RESPONSE:
                if req_id == -1:
                    print("AUTH FAILED", file=sys.stderr)
                    return 1
                break

        for i, command in enumerate(commands, start=2):
            sock.sendall(_pack(i, SERVERDATA_EXECCOMMAND, command))
            # Responses can be split across packets; a sentinel that echoes back
            # after the real reply is the standard way to know it ended.
            sock.sendall(_pack(1000 + i, SERVERDATA_EXECCOMMAND, ""))
            out = []
            while True:
                req_id, _, chunk = _read(sock)
                if req_id == 1000 + i:
                    break
                out.append(chunk)
            print(f"----- {command} -----")
            print("".join(out).strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
