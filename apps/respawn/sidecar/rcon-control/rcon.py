#!/usr/bin/env python3
r"""Send one rcon command to the game container over loopback.

This runs *inside* the ECS task, alongside the game. Containers in a task share a
network namespace, so the game answers on 127.0.0.1 and the rcon password never
crosses the internet — it arrives as an ECS secret and stays in the task.

Routing lives in the caller: one control sidecar fronts exactly one game server,
and it learns which one from its environment (RCON_PROTOCOL, RCON_PORT). An MCP
client selects the server by choosing which task to exec into.

Five wire protocols, because the engines differ:
  goldsrc    UDP. Challenge, then `rcon <challenge> "<pass>" <cmd>`. The password
             is re-sent with every command (protocol limitation).
  source     TCP, length-prefixed packets. Authenticate once per connection.
  q3         idTech3 (Quake 3 / Quake Live). One connectionless UDP packet.
  zandronum  Stateful, Huffman-coded UDP with salted-MD5 auth (Doom 2 etc.).
  gamespy    Unreal Engine 1 (UT99) query port. Read-only and unauthenticated —
             it answers `\info\`/`\players\` and takes no commands at all.

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


def q3_exec(host: str, port: int, password: str, command: str, timeout: float) -> str:
    """idTech3 (Quake 3 / Quake Live) rcon: one connectionless UDP packet.

    Request:  \\xff\\xff\\xff\\xff rcon <password> <command>
    Reply:    \\xff\\xff\\xff\\xff print\\n <text>, which large replies fragment
              across several packets — we read until the socket goes quiet.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        request = b"\xff\xff\xff\xffrcon " + f"{password} {command}".encode("latin-1")
        sock.sendto(request, (host, port))

        chunks: list[bytes] = []
        while True:
            try:
                data, _ = sock.recvfrom(8192)
            except socket.timeout:
                break
            # Each fragment is prefixed 0xFFFFFFFF and usually 'print\n'.
            body = data[4:]
            if body.startswith(b"print\n"):
                body = body[len("print\n") :]
            chunks.append(body)
            if not chunks:  # first read must succeed; later ones may time out
                break
            sock.settimeout(0.4)  # short wait for continuation fragments

        if not chunks:
            raise RconError(f"no reply from {host}:{port}")
        text = b"".join(chunks).decode("latin-1", errors="replace").strip()
        if "Bad rconpassword" in text or "No rconpassword" in text:
            raise RconError("rcon password rejected or not set on the server")
        return text
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


# --- Zandronum rcon ----------------------------------------------------------
# A stateful, Huffman-coded UDP protocol with salted-MD5 auth. The Huffman tree
# is lifted verbatim from zandronum/src/huffman/huffman.cpp; its codec honours a
# 0xff "unencoded" prefix, so we can *send* without an encoder and only decode
# replies. Flow (sv_rcon.cpp): BEGINCONNECTION -> SALT -> md5(salt+password) ->
# COMMAND -> MESSAGE.
_ZAN_TREE = bytes.fromhex(
    "0000000180000000032622020150036e90430002014a03f38e2502037c3ab6000001240003dd"
    "8303f5a30123037155000129014d03c7820001ce03b9990346760003030500000118000203c6"
    "be3f02038bba4b00012c0203f0da380328270000020203f4f751410003097d03443c00000119"
    "03bf8a03561100011703dcb20203a5c20e0100020200000201d003969db501de0203d8e6d300"
    "020203fc8d0a2a000203868768016703bbe15f200000000000000139013d03b7ed000003e9ea"
    "03f6cb0203fa934f0181000107038f88011403b394000000031c6a03655701420003b4db03e3"
    "f100011a01fb03e5d6033645000000000003e7d4039cb0035d53000360fd031e0d00000203af"
    "fe5e039f1b02010803cce24e000000036b58011f0389a9020203d7910604017f00016303d1d9"
    "0003d5ee03b1aa01840000000203160c720202039ec5612d00012e017003aef90003e0660203"
    "ab97c1000000030f100302a80131035b9200013003ad1d0003137e035cf200000000000003cd"
    "c00203eb95ff0203dfb8f80000036cec036f5a02037573470000030b320003bc77017a03a7a2"
    "01a00185037b15000002013b02039b9a622b00034c330203c97448020002036d64790203c3e8"
    "120100020001a4020378bd490001c403efd203403e59000001210203e4a137020354982f0000"
    "0203cfac8c0352a600033569013403cac8"
)
ZANDRONUM_RCON_PROTOCOL = 4
CLRC_BEGINCONNECTION, CLRC_PASSWORD, CLRC_COMMAND = 52, 53, 54
SVRC_OLDPROTOCOL, SVRC_BANNED, SVRC_SALT = 32, 33, 34
SVRC_LOGGEDIN, SVRC_INVALIDPASSWORD, SVRC_MESSAGE = 35, 36, 37


# A node is a 2-element list; a child is a literal byte (leaf) or a node (branch).
_HuffNode = list


def _zan_build_tree(data: bytes) -> _HuffNode:
    pos = 0

    def node() -> _HuffNode:
        nonlocal pos
        desc = data[pos]
        pos += 1
        children: _HuffNode = [None, None]
        for i in (0, 1):
            if desc & (1 << i):
                children[i] = data[pos]
                pos += 1
            else:
                children[i] = node()
        return children

    return node()


_ZAN_ROOT = _zan_build_tree(_ZAN_TREE)
_ZAN_REV = [int(f"{b:08b}"[::-1], 2) for b in range(256)]


def _zan_decode(buf: bytes) -> bytes:
    if buf[:1] == b"\xff":
        return buf[1:]
    bits = ((len(buf) - 1) << 3) - buf[0]
    out = bytearray()
    node: _HuffNode = _ZAN_ROOT
    byte, left, read = 0, 0, 1
    while bits > 0:
        if left <= 0:
            byte = _ZAN_REV[buf[read]]
            read += 1
            left = 8
        child = node[(byte >> 7) & 1]
        byte = (byte << 1) & 0xFF
        left -= 1
        bits -= 1
        if isinstance(child, int):
            out.append(child)
            node = _ZAN_ROOT
        else:
            node = child
    return bytes(out)


def zandronum_exec(host: str, port: int, password: str, command: str, timeout: float) -> str:
    import hashlib

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)

    def send(payload: bytes) -> None:
        sock.sendto(b"\xff" + payload, (host, port))  # 0xff = unencoded

    def recv() -> bytes:
        data, _ = sock.recvfrom(8192)
        return _zan_decode(data)

    try:
        send(bytes([CLRC_BEGINCONNECTION, ZANDRONUM_RCON_PROTOCOL]))
        reply = recv()
        code = reply[0]
        if code == SVRC_BANNED:
            raise RconError("this host is banned from the server's rcon")
        if code == SVRC_OLDPROTOCOL:
            raise RconError("server rejected the rcon protocol version")
        if code != SVRC_SALT:
            raise RconError(f"unexpected rcon reply {code} (expected salt)")
        salt = reply[1 : reply.index(b"\x00", 1)].decode("latin-1")

        digest = hashlib.md5((salt + password).encode("latin-1")).hexdigest()
        send(bytes([CLRC_PASSWORD]) + digest.encode("latin-1") + b"\x00")
        reply = recv()
        if reply[0] == SVRC_INVALIDPASSWORD:
            raise RconError("rcon password rejected")
        if reply[0] != SVRC_LOGGEDIN:
            raise RconError(f"unexpected login reply {reply[0]}")

        send(bytes([CLRC_COMMAND]) + command.encode("latin-1") + b"\x00")

        # Collect SVRC_MESSAGE payloads until the socket goes quiet.
        messages: list[str] = []
        sock.settimeout(1.0)
        while True:
            try:
                reply = recv()
            except socket.timeout:
                break
            if reply and reply[0] == SVRC_MESSAGE:
                messages.append(reply[1 : reply.index(b"\x00", 1)].decode("latin-1"))
        return "".join(messages).strip()
    except socket.timeout as exc:
        raise RconError(f"no reply from {host}:{port} within {timeout}s") from exc
    finally:
        sock.close()


# GameSpy v1 queries an Unreal Engine 1 server answers. `status` is the union of
# basic+info+rules+players and is what the browsers use.
GAMESPY_QUERIES = ("info", "basic", "rules", "players", "status", "echo")


def _gamespy_pairs(payload: str) -> list[tuple[str, str]]:
    r"""Split a GameSpy infostring `\k\v\k\v\` into ordered key/value pairs.

    Keys repeat (`\status\` sends `gamever` twice), so this is a list, not a dict.
    A trailing key with no value is dropped rather than paired with the terminator.
    """
    parts = payload.split("\\")
    if parts and parts[0] == "":
        parts = parts[1:]
    pairs: list[tuple[str, str]] = []
    for i in range(0, len(parts) - 1, 2):
        pairs.append((parts[i], parts[i + 1]))
    return pairs


def _split_index(key: str) -> tuple[str, int] | None:
    r"""Split a GameSpy indexed key `base_N` into `(base, N)`, else None.

    Player fields arrive keyed by slot — `player_0`, `frags_0`, `player_1`, ... — so
    the trailing `_<digits>` groups a row rather than naming a field.
    """
    cut = key.rfind("_")
    if cut > 0 and key[cut + 1 :].isdigit():
        return key[:cut], int(key[cut + 1 :])
    return None


def _gamespy_normalize(payload: str) -> str:
    r"""Turn a GameSpy infostring into lines the query engine can match.

    Scalar keys become one `key=value` line each. Indexed keys (`player_0`, `frags_0`)
    are transposed: all fields sharing an index collapse into a single tab-joined line
    of `base=value` pairs — one line per player — because the query engine matches
    `row` patterns per line and a player is otherwise smeared across eight of them.

    Values are stripped (GameSpy pads `ping` with a leading space) and any tab inside
    a value becomes a space, so tab stays a clean field separator for the row regex.
    """
    scalar: list[str] = []
    rows: dict[int, list[tuple[str, str]]] = {}
    for key, value in _gamespy_pairs(payload):
        if key in ("queryid", "final"):
            continue
        clean = value.strip().replace("\t", " ")
        indexed = _split_index(key)
        if indexed is None:
            scalar.append(f"{key}={clean}")
        else:
            base, idx = indexed
            rows.setdefault(idx, []).append((base, clean))
    lines = list(scalar)
    for idx in sorted(rows):
        lines.append("\t".join(f"{base}={val}" for base, val in rows[idx]))
    return "\n".join(lines)


def _gamespy_reassemble(packets: list[bytes]) -> str:
    r"""Order multi-packet replies by their `\queryid\N.M` sequence number.

    UDP gives no ordering guarantee and a populated `\players\` reply spans several
    datagrams, so sort on M rather than on arrival.
    """
    numbered: list[tuple[int, str]] = []
    for index, raw in enumerate(packets):
        text = raw.decode("latin-1")
        seq = index
        for key, value in _gamespy_pairs(text):
            if key == "queryid" and "." in value:
                try:
                    seq = int(value.split(".", 1)[1])
                except ValueError:
                    pass
                break
        numbered.append((seq, text))
    numbered.sort(key=lambda item: item[0])
    return "".join(text for _, text in numbered)


def gamespy_exec(host: str, port: int, password: str, command: str, timeout: float) -> str:
    r"""GameSpy v1 query (Unreal Engine 1: UT99). Read-only, and unauthenticated.

    `password` is accepted to match the dispatch signature and deliberately unused:
    the query port takes no credentials. That also means this protocol can never
    back run_command or set_cvar — it only reads. UT99's writes live behind the
    web admin on a different port.

    Request:  \\<query>\\   e.g. \\info\\
    Reply:    \\k\\v\\...\\queryid\\N.M\\final\\, fragmented across datagrams when
              long. Prefix a query with `raw:` to get the wire payload verbatim,
              which is how an unfamiliar reply gets captured before it is parsed.

    Returns scalar fields as `key=value` lines and player slots as one tab-joined
    line each (see _gamespy_normalize) — the query engine matches per line, and a
    single `\\k\\v\\` blob has no lines to match.
    """
    query = (command or "info").strip()
    raw_mode = query.startswith("raw:")
    if raw_mode:
        query = query[len("raw:") :].strip()
    query = query.strip("\\").lower() or "info"
    if query not in GAMESPY_QUERIES:
        raise RconError(
            f"unknown gamespy query {query!r}; expected one of {', '.join(GAMESPY_QUERIES)}"
        )

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(f"\\{query}\\".encode("latin-1"), (host, port))
        packets: list[bytes] = []
        while True:
            try:
                data, _ = sock.recvfrom(65535)
            except socket.timeout:
                break
            packets.append(data)
            if b"\\final\\" in data:
                break
        if not packets:
            raise RconError(f"no reply from {host}:{port} within {timeout}s")

        payload = _gamespy_reassemble(packets)
        if raw_mode:
            return payload
        return _gamespy_normalize(payload)
    finally:
        sock.close()


PROTOCOLS = {
    "goldsrc": goldsrc_exec,
    "source": source_exec,
    "q3": q3_exec,
    "zandronum": zandronum_exec,
    "gamespy": gamespy_exec,
}

# Query-only protocols whose port takes no credentials. Requiring a password for
# these would force a pointless secret on a service that has none to give.
UNAUTHENTICATED_PROTOCOLS = frozenset({"gamespy"})


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
    if not password and args.protocol not in UNAUTHENTICATED_PROTOCOLS:
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
