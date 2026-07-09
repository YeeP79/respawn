#!/usr/bin/env python3
"""Send one rcon command to the game container over loopback.

This runs *inside* the ECS task, alongside the game. Containers in a task share a
network namespace, so the game answers on 127.0.0.1 and the rcon password never
crosses the internet — it arrives as an ECS secret and stays in the task.

Routing lives in the caller: one control sidecar fronts exactly one game server,
and it learns which one from its environment (RCON_PROTOCOL, RCON_PORT). An MCP
client selects the server by choosing which task to exec into.

Two wire protocols, because the engines differ:
  goldsrc  UDP on the game port. Challenge, then `rcon <challenge> "<pass>" <cmd>`.
           The password is re-sent with every command (protocol limitation).
  source   TCP, length-prefixed packets. Authenticate once per connection.

Exit codes: 0 on success, 1 on failure (auth rejected, timeout, bad protocol).
"""

import argparse
import os
import socket
import struct
import sys

GOLDSRC_PREFIX = b"\xff\xff\xff\xff"

# Source RCON packet types
SERVERDATA_AUTH = 3
SERVERDATA_AUTH_RESPONSE = 2
SERVERDATA_EXECCOMMAND = 2
SERVERDATA_RESPONSE_VALUE = 0


class RconError(Exception):
    """Any failure to execute the command: transport, auth, or protocol."""


def goldsrc_exec(host: str, port: int, password: str, command: str, timeout: float) -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(GOLDSRC_PREFIX + b"challenge rcon\n", (host, port))
        reply, _ = sock.recvfrom(4096)
        parts = reply.decode("latin-1").split()
        if len(parts) < 3:
            raise RconError(f"unexpected challenge reply: {reply[:40]!r}")
        challenge = parts[2].strip("\x00")

        request = f'rcon {challenge} "{password}" {command}\n'
        sock.sendto(GOLDSRC_PREFIX + request.encode("latin-1"), (host, port))
        response, _ = sock.recvfrom(8192)

        # Strip the 0xFFFFFFFF prefix and the 'l' payload marker.
        body = response[5:].decode("latin-1")
        if "Bad rcon_password" in body:
            raise RconError("rcon password rejected")
        return body.strip()
    except socket.timeout as exc:
        raise RconError(f"no reply from {host}:{port} within {timeout}s") from exc
    finally:
        sock.close()


def _source_packet(packet_id: int, packet_type: int, body: str) -> bytes:
    payload = struct.pack("<ii", packet_id, packet_type) + body.encode("utf-8") + b"\x00\x00"
    return struct.pack("<i", len(payload)) + payload


def _source_read(sock: socket.socket) -> tuple[int, int, str]:
    raw_size = _recv_exact(sock, 4)
    size = struct.unpack("<i", raw_size)[0]
    payload = _recv_exact(sock, size)
    packet_id, packet_type = struct.unpack("<ii", payload[:8])
    body = payload[8:-2].decode("utf-8", errors="replace")
    return packet_id, packet_type, body


def _recv_exact(sock: socket.socket, count: int) -> bytes:
    chunks = b""
    while len(chunks) < count:
        chunk = sock.recv(count - len(chunks))
        if not chunk:
            raise RconError("connection closed by the game server")
        chunks += chunk
    return chunks


def source_exec(host: str, port: int, password: str, command: str, timeout: float) -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))

        sock.sendall(_source_packet(1, SERVERDATA_AUTH, password))
        # Servers answer auth with an empty RESPONSE_VALUE then the AUTH_RESPONSE.
        while True:
            packet_id, packet_type, _ = _source_read(sock)
            if packet_type == SERVERDATA_AUTH_RESPONSE:
                break
        if packet_id == -1:
            raise RconError("rcon password rejected")

        sock.sendall(_source_packet(2, SERVERDATA_EXECCOMMAND, command))
        _, _, body = _source_read(sock)
        return body.strip()
    except socket.timeout as exc:
        raise RconError(f"no reply from {host}:{port} within {timeout}s") from exc
    except (ConnectionRefusedError, OSError) as exc:
        raise RconError(f"cannot reach {host}:{port}: {exc}") from exc
    finally:
        sock.close()


PROTOCOLS = {"goldsrc": goldsrc_exec, "source": source_exec}


def main() -> int:
    parser = argparse.ArgumentParser(description="Execute one rcon command over loopback.")
    parser.add_argument("--command", help="rcon command, e.g. 'status' or 'changelevel de_nuke'")
    parser.add_argument("--info", action="store_true", help="print which server this sidecar fronts")
    parser.add_argument("--protocol", default=os.environ.get("RCON_PROTOCOL", "goldsrc"))
    parser.add_argument("--host", default=os.environ.get("RCON_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("RCON_PORT", "27015")))
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("RCON_TIMEOUT_SECONDS", "6")))
    args = parser.parse_args()

    if args.info:
        print(f"service={os.environ.get('SERVICE_NAME', '?')}")
        print(f"protocol={args.protocol}")
        print(f"target={args.host}:{args.port}")
        return 0

    if not args.command:
        print("error: --command is required (or use --info)", file=sys.stderr)
        return 1

    password = os.environ.get("RCON_PASSWORD", "")
    if not password:
        print("error: RCON_PASSWORD is not set in this container", file=sys.stderr)
        return 1

    handler = PROTOCOLS.get(args.protocol)
    if handler is None:
        print(
            f"error: unknown RCON_PROTOCOL {args.protocol!r}; expected one of {sorted(PROTOCOLS)}",
            file=sys.stderr,
        )
        return 1

    try:
        print(handler(args.host, args.port, password, args.command, args.timeout))
    except RconError as exc:
        # Never echo the password, not even in an error path.
        print(f"rcon failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
