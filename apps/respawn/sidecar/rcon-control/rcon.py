#!/usr/bin/env python3
r"""Send one rcon command to the game container over loopback.

This runs *inside* the ECS task, alongside the game. Containers in a task share a
network namespace, so the game answers on 127.0.0.1 and the rcon password never
crosses the internet — it arrives as an ECS secret and stays in the task.

Routing lives in the caller: one control sidecar fronts exactly one game server,
and it learns which one from its environment (RCON_PROTOCOL, RCON_PORT). An MCP
client selects the server by choosing which task to exec into.

Seven wire protocols, because the engines differ:
  goldsrc          UDP. Challenge, then `rcon <challenge> "<pass>" <cmd>`. The password
                   is re-sent with every command (protocol limitation).
  source           TCP, length-prefixed packets. Authenticate once per connection.
  q3               idTech3 (Quake 3 / Quake Live). One connectionless UDP packet.
  zandronum        Stateful, Huffman-coded UDP with salted-MD5 auth (Doom 2 etc.).
                   Executes commands but reports NOTHING about who is playing.
  zandronum-query  The Zandronum *launcher* port (same UDP port). Read-only and
                   unauthenticated; this is the only way to see a Doom 2 roster.
  gamespy          Unreal Engine 1 (UT99) query port. Read-only and unauthenticated —
                   it answers `\info\`/`\players\` and takes no commands at all.
  uweb             UE1 web admin console (UT99 writes).

A service may speak TWO of these: a read transport (queries) and a write transport
(commands), selected by --write. UT99 reads on gamespy and writes on uweb; Doom 2 is
the inverse — it reads on zandronum-query and writes on zandronum rcon.

Exit codes: 0 on success, 1 on failure (auth rejected, timeout, bad protocol).
"""

import argparse
import base64
import html
import os
import re
import socket
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable

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


# --- Zandronum launcher protocol (the READ half of a Zandronum service) --------
#
# Zandronum rcon (above) executes commands but reports nothing about who is playing.
# The *launcher* protocol on the same UDP port does: it is the unauthenticated query
# the server browsers use. Pairing them gives Doom 2 the read/write split UT99 already
# has (gamespy reads, uweb writes) — here inverted: launcher reads, rcon writes.
#
# Request:  0xff <SQF flags> — the 0xff prefix is the Huffman codec's "rest is
#           unencoded" marker, which is why no encoder is needed, only _zan_decode.
# Reply:    Huffman-coded. Fields appear in ASCENDING FLAG-BIT ORDER, and the reply
#           ECHOES the flags, so the parse is self-describing.
#
# Every offset below was verified against a live zandronum 3.2.1 server in BOTH a
# non-team (coop) and a team (teamplay) game — see the player-record note.
ZANDRONUM_LAUNCHER_CHALLENGE = 199
ZANDRONUM_SERVER_CHALLENGE = 5660023
ZANDRONUM_SERVER_IGNORING = 5660024  # query flood protection (sv_queryignoretime)
ZANDRONUM_SERVER_BANNED = 5660025

SQF_NAME = 0x00000001
SQF_MAPNAME = 0x00000008
SQF_MAXCLIENTS = 0x00000010
SQF_MAXPLAYERS = 0x00000020
SQF_GAMETYPE = 0x00000080
SQF_GAMENAME = 0x00000100
SQF_IWAD = 0x00000200
SQF_GAMESKILL = 0x00001000
SQF_NUMPLAYERS = 0x00080000
SQF_PLAYERDATA = 0x00100000

_SQF_INFO = (
    SQF_NAME | SQF_MAPNAME | SQF_MAXCLIENTS | SQF_MAXPLAYERS | SQF_GAMETYPE
    | SQF_GAMENAME | SQF_IWAD | SQF_GAMESKILL | SQF_NUMPLAYERS
)
# GAMETYPE is requested even for `players`: a team gamemode adds a byte to every
# player record, so the parse cannot be done without knowing the mode.
_SQF_PLAYERS = SQF_GAMETYPE | SQF_NUMPLAYERS | SQF_PLAYERDATA

ZANDRONUM_QUERIES = {
    "info": _SQF_INFO,
    "players": _SQF_PLAYERS,
    "status": _SQF_INFO | SQF_PLAYERDATA,
}

# Zandronum GAMEMODE_e values that are team games. Only these carry a `team` byte in
# each player record. The parser treats this as a HINT and still validates by exact
# buffer consumption, so an unknown future mode cannot silently corrupt a row.
_ZAN_TEAM_MODES = frozenset({4, 8, 10, 11, 12, 13, 14, 15})


def zandronum_query_exec(
    host: str, port: int, password: str, command: str, timeout: float
) -> str:
    """Query the Zandronum launcher port. Read-only: never sends back a command.

    Returns the Huffman-DECODED packet as hex. The wire here is binary, so its faithful
    "raw" rendering is the bytes themselves — `--raw` (capture_raw) hands those back
    losslessly, which is exactly what authoring a parser for a binary protocol needs.
    _zandronum_query_normalize turns them into the key=value / player= lines the query
    engine matches, keeping fetch and reshape separate as every other transport does.
    """
    query = (command or "info").strip().lower() or "info"
    if query not in ZANDRONUM_QUERIES:
        raise RconError(
            f"unknown zandronum query {query!r}; expected one of "
            f"{', '.join(sorted(ZANDRONUM_QUERIES))}"
        )

    request = b"\xff" + struct.pack(
        "<III",
        ZANDRONUM_LAUNCHER_CHALLENGE,
        ZANDRONUM_QUERIES[query],
        int(time.time()) & 0xFFFFFFFF,
    )
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(request, (host, port))
        data, _ = sock.recvfrom(8192)
    except socket.timeout as exc:
        raise RconError(f"no reply from {host}:{port} within {timeout}s") from exc
    finally:
        sock.close()

    raw = _zan_decode(data)
    if len(raw) < 4:
        raise RconError("short reply from zandronum launcher port")
    code = struct.unpack("<I", raw[0:4])[0]
    if code == ZANDRONUM_SERVER_IGNORING:
        # Rate limiting is NOT an empty server. Must surface as an error so the
        # watchdog reads it as "unknown" rather than "nobody is playing".
        raise RconError("server is rate-limiting queries (sv_queryignoretime)")
    if code == ZANDRONUM_SERVER_BANNED:
        raise RconError("this host is banned from querying the server")
    if code != ZANDRONUM_SERVER_CHALLENGE:
        raise RconError(f"unexpected zandronum response code {code}")
    return raw.hex()


def _zandronum_query_normalize(hex_reply: str) -> str:
    """Reshape a decoded launcher reply into `key=value` lines and `player=` rows.

    Field order follows ascending SQF bit order and the reply echoes the flags, so this
    reads only what was actually asked for. Player records are `name, frags(i16),
    ping(i16), spec(u8), bot(u8), [team(u8) — TEAM MODES ONLY], time(u8)`; the team byte
    is why the record length is 8 in CTF/teamplay and 7 in coop/deathmatch. The layout is
    chosen by the gamemode and then CONFIRMED by exact buffer consumption — a mismatch
    raises rather than emitting a plausible, wrong roster.
    """
    raw = bytes.fromhex(hex_reply)
    off = raw.index(b"\x00", 8) + 1  # response code(4) + echoed time(4) + version NTS
    flags = struct.unpack("<I", raw[off : off + 4])[0]
    off += 4

    def nts() -> str:
        nonlocal off
        end = raw.index(b"\x00", off)
        value = raw[off:end].decode("latin-1")
        off = end + 1
        return value

    def u8() -> int:
        nonlocal off
        value = raw[off]
        off += 1
        return value

    lines: list[str] = []
    gametype = -1
    if flags & SQF_NAME:
        lines.append(f"hostname={nts()}")
    if flags & SQF_MAPNAME:
        lines.append(f"mapname={nts()}")
    if flags & SQF_MAXCLIENTS:
        lines.append(f"maxclients={u8()}")
    if flags & SQF_MAXPLAYERS:
        lines.append(f"maxplayers={u8()}")
    if flags & SQF_GAMETYPE:
        gametype = u8()
        instagib, buckshot = u8(), u8()
        lines.append(f"gametype={gametype}")
        lines.append(f"instagib={instagib}")
        lines.append(f"buckshot={buckshot}")
    if flags & SQF_GAMENAME:
        lines.append(f"gamename={nts()}")
    if flags & SQF_IWAD:
        lines.append(f"iwad={nts()}")
    if flags & SQF_GAMESKILL:
        lines.append(f"skill={u8()}")

    count = 0
    if flags & SQF_NUMPLAYERS:
        count = u8()
        lines.append(f"numplayers={count}")

    if flags & SQF_PLAYERDATA:
        start = off
        hinted = 8 if gametype in _ZAN_TEAM_MODES else 7
        for size in (hinted, 15 - hinted):  # try the hint, then the only alternative
            off = start
            rows: list[str] = []
            try:
                for _ in range(count):
                    end = raw.index(b"\x00", off)
                    name = raw[off:end].decode("latin-1")
                    off = end + 1
                    rec = raw[off : off + size]
                    if len(rec) < size:
                        raise ValueError("truncated player record")
                    off += size
                    frags, ping = struct.unpack("<hh", rec[0:4])
                    spec, bot = rec[4], rec[5]
                    team = rec[6] if size == 8 else -1
                    seconds = rec[7] if size == 8 else rec[6]
                    rows.append(
                        f"player={name}\tfrags={frags}\tping={ping}\tteam={team}"
                        f"\tbot={bot}\tspec={spec}\ttime={seconds}"
                    )
            except (ValueError, IndexError, struct.error):
                continue
            if off == len(raw):  # consumed exactly -> this layout is the right one
                lines.extend(rows)
                break
        else:
            raise RconError(
                "could not parse zandronum player data (no record size consumed the "
                "reply exactly) — refusing to report a roster that may be wrong"
            )

    return "\n".join(lines)


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
              long.

    Returns the reassembled wire infostring verbatim. The dispatch layer applies
    _gamespy_normalize afterwards (see NORMALIZERS) unless --raw is set, which keeps
    fetching and reshaping separate so an unfamiliar reply can be captured before
    anyone writes a parser for it.
    """
    query = (command or "info").strip().strip("\\").lower() or "info"
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
        return _gamespy_reassemble(packets)
    finally:
        sock.close()


# UWeb (Unreal Engine 1 web admin) console. UT99's writes live here, not on the
# GameSpy query port: the server runs an authenticated HTTP admin whose "console"
# accepts the same commands an in-game admin types after `adminlogin`. This is the
# write counterpart to gamespy's read — a service can speak both (reads on 7778,
# writes on 5580). Verified against roemer/ut99-server: the console form POSTs
# `SendText`/`Send` to /ServerAdmin/current_console, and command output surfaces in
# the separate /ServerAdmin/current_console_log frame — the POST body is just the
# form page, so a reply worth returning has to be read back from the log.
UWEB_CONSOLE_PATH = "/ServerAdmin/current_console"
UWEB_LOG_PATH = "/ServerAdmin/current_console_log"
# Keep the reply to the recent tail: the log is cumulative, and only the lines a
# command just produced are useful feedback.
UWEB_LOG_TAIL = 12


def _uweb_request(url: str, user: str, password: str, timeout: float, data: bytes | None) -> str:
    """One authenticated request to the web admin; returns the decoded body.

    Basic auth is set explicitly rather than via an opener/handler so a 401 is a
    single clean HTTPError rather than a silent retry, and no realm negotiation is
    needed. `data` selects POST vs GET.
    """
    request = urllib.request.Request(url, data=data)
    token = base64.b64encode(f"{user}:{password}".encode("latin-1")).decode("ascii")
    request.add_header("Authorization", f"Basic {token}")
    if data is not None:
        request.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read().decode("latin-1", errors="replace")
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise RconError("web admin rejected the credentials (401)") from exc
        raise RconError(f"web admin returned HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RconError(f"cannot reach web admin at {url}: {exc.reason}") from exc


# Page chrome in the log frame that carries no log content: the head (title + CSS),
# scripts, styles, and the hidden status span the page copies into its parent frame.
# Stripping these before splitting keeps JS/CSS text out of the returned reply.
_UWEB_CHROME = re.compile(
    r"<head\b.*?</head>|<script\b.*?</script>|<style\b.*?</style>"
    r'|<span[^>]*display:\s*none[^>]*>.*?</span>',
    re.IGNORECASE | re.DOTALL,
)


def _uweb_parse_log(body: str) -> str:
    r"""Reduce the console-log HTML to its recent event lines.

    The frame renders each line as `&gt; (Type) text<br>`, several concatenated on
    one physical line. Drop the page chrome, split on the breaks, strip tags, unescape
    entities, and shed the `>` prompt — then keep the tail, the fresh lines a command
    just produced rather than the whole session backlog.
    """
    body = _UWEB_CHROME.sub("", body)
    lines: list[str] = []
    for chunk in re.split(r"<br\s*/?>", body, flags=re.IGNORECASE):
        text = html.unescape(re.sub(r"<[^>]+>", "", chunk)).strip()
        text = text.lstrip("> ").strip()
        if text:
            lines.append(text)
    return "\n".join(lines[-UWEB_LOG_TAIL:])


def uweb_exec(host: str, port: int, password: str, command: str, timeout: float) -> str:
    """Run one admin command through the Unreal Engine 1 web admin console.

    The username is not part of the dispatch signature (which every transport shares),
    so it is read from the environment here — the same shape as gamespy ignoring its
    unused `password`. POST the command, then read the log frame back so the caller
    gets the command's output, not the empty form the POST returns.
    """
    user = os.environ.get("RCON_WRITE_USER", "")
    base = f"http://{host}:{port}"
    payload = urllib.parse.urlencode({"SendText": command, "Send": "Send"}).encode("latin-1")
    _uweb_request(base + UWEB_CONSOLE_PATH, user, password, timeout, payload)
    log = _uweb_request(base + UWEB_LOG_PATH, user, password, timeout, None)
    return _uweb_parse_log(log) or "(command sent; web admin returned no console output)"


PROTOCOLS = {
    "goldsrc": goldsrc_exec,
    "source": source_exec,
    "q3": q3_exec,
    "zandronum": zandronum_exec,
    "zandronum-query": zandronum_query_exec,
    "gamespy": gamespy_exec,
    "uweb": uweb_exec,
}

# Post-fetch reshapers, keyed by protocol. A handler returns the transport's reply as
# text; its normalizer (if any) restructures that into the lines the query engine
# matches. --raw skips this step for every protocol uniformly, so a new reshaping
# transport only has to register here — the introspection tooling needs no change.
NORMALIZERS: dict[str, Callable[[str], str]] = {
    "gamespy": _gamespy_normalize,
    "zandronum-query": _zandronum_query_normalize,
}

# Query-only protocols whose port takes no credentials. Requiring a password for
# these would force a pointless secret on a service that has none to give.
UNAUTHENTICATED_PROTOCOLS = frozenset({"gamespy", "zandronum-query"})


def main() -> int:
    parser = argparse.ArgumentParser(description="Execute one rcon command over loopback.")
    parser.add_argument("--command", help="rcon command, e.g. 'status' or 'changelevel de_nuke'")
    parser.add_argument("--info", action="store_true", help="print which server this sidecar fronts")
    parser.add_argument(
        "--raw",
        action="store_true",
        help="skip protocol normalization; return the transport reply verbatim",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="use the write transport (RCON_WRITE_*) for a state-changing command",
    )
    parser.add_argument("--protocol", default=os.environ.get("RCON_PROTOCOL", "goldsrc"))
    parser.add_argument("--host", default=os.environ.get("RCON_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("RCON_PORT", "27015")))
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("RCON_TIMEOUT_SECONDS", "6")))
    args = parser.parse_args()

    # A server may front two transports: a read path (RCON_*, e.g. gamespy queries)
    # and an optional write path (RCON_WRITE_*, e.g. the uweb admin console). --write
    # selects the latter; with no write transport configured it falls through to the
    # read path, so a single-rcon game (goldsrc/source/...) writes over its one
    # transport unchanged. UT99 is the case that needs the split: it reads on gamespy
    # (7778, unauthenticated) but writes on uweb (5580, authenticated).
    write_protocol = os.environ.get("RCON_WRITE_PROTOCOL")
    if args.write and write_protocol:
        protocol: str = write_protocol
        host: str = os.environ.get("RCON_WRITE_HOST") or args.host
        port: int = int(os.environ.get("RCON_WRITE_PORT") or args.port)
        password: str = os.environ.get("RCON_WRITE_PASSWORD", "")
        password_var = "RCON_WRITE_PASSWORD"
    else:
        protocol = args.protocol
        host = args.host
        port = args.port
        password = os.environ.get("RCON_PASSWORD", "")
        password_var = "RCON_PASSWORD"

    if args.info:
        print(f"service={os.environ.get('SERVICE_NAME', '?')}")
        print(f"protocol={args.protocol}")
        print(f"target={args.host}:{args.port}")
        if write_protocol:
            wport = os.environ.get("RCON_WRITE_PORT", str(args.port))
            whost = os.environ.get("RCON_WRITE_HOST", args.host)
            print(f"write_protocol={write_protocol}")
            print(f"write_target={whost}:{wport}")
        return 0

    if not args.command:
        print("error: --command is required (or use --info)", file=sys.stderr)
        return 1

    if not password and protocol not in UNAUTHENTICATED_PROTOCOLS:
        print(f"error: {password_var} is not set in this container", file=sys.stderr)
        return 1

    handler = PROTOCOLS.get(protocol)
    if handler is None:
        print(
            f"error: unknown protocol {protocol!r}; expected one of {sorted(PROTOCOLS)}",
            file=sys.stderr,
        )
        return 1

    try:
        reply = handler(host, port, password, args.command, args.timeout)
        normalize = NORMALIZERS.get(protocol)
        if normalize is not None and not args.raw:
            reply = normalize(reply)
        print(reply)
    except RconError as exc:
        # Never echo the password, not even in an error path.
        print(f"rcon failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
