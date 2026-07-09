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
import struct
import sys
import time

A2S_INFO = b"\xff\xff\xff\xffTSource Engine Query\x00"
A2S_CHALLENGE = 0x41
A2S_SOURCE = 0x49
A2S_GOLDSRC = 0x6D

Q3_GETSTATUS = b"\xff\xff\xff\xffgetstatus\n"
GAMESPY_INFO = b"\\info\\"

# --- Zandronum launcher protocol ---------------------------------------------
# Its packets are Huffman-coded with a fixed tree, lifted verbatim from
# zandronum/src/huffman/huffman.cpp (`compatible_huffman_tree`). A 0xff first
# byte means "the rest is unencoded" — the codec's own fallback when coding would
# expand the data — so we can *send* without implementing the encoder.
ZANDRONUM_TREE = bytes.fromhex(
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
ZANDRONUM_LAUNCHER_CHALLENGE = 199
ZANDRONUM_SERVER_CHALLENGE = 5660023
ZANDRONUM_SERVER_IGNORING = 5660024  # query flood protection (sv_queryignoretime)
ZANDRONUM_SERVER_BANNED = 5660025
SQF_NAME = 0x00000001
SQF_NUMPLAYERS = 0x00080000


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


# A node is a 2-element list of children; a child is either a literal byte (leaf)
# or another node (branch).
HuffNode = list  # list[int | HuffNode]


def _build_huffman_tree(data: bytes) -> HuffNode:
    """Rebuild the codec's tree. Each descriptor bit: 0 = branch, 1 = leaf byte."""
    pos = 0

    def node() -> HuffNode:
        nonlocal pos
        desc = data[pos]
        pos += 1
        children: HuffNode = [None, None]
        for i in (0, 1):
            if desc & (1 << i):
                children[i] = data[pos]  # leaf: literal byte value
                pos += 1
            else:
                children[i] = node()  # branch: recurse
        return children

    return node()


_ZAN_ROOT = _build_huffman_tree(ZANDRONUM_TREE)
_ZAN_REVERSED = [int(f"{b:08b}"[::-1], 2) for b in range(256)]


def zandronum_decode(buf: bytes) -> bytes:
    """Huffman-decode a Zandronum packet. A 0xff first byte means unencoded."""
    if buf[:1] == b"\xff":
        return buf[1:]

    bits_available = ((len(buf) - 1) << 3) - buf[0]  # byte 0 = padding bit count
    out = bytearray()
    node: HuffNode = _ZAN_ROOT
    byte, bits_left, read = 0, 0, 1

    while bits_available > 0:
        if bits_left <= 0:
            if read >= len(buf):
                raise ValueError("truncated zandronum packet")
            byte = _ZAN_REVERSED[buf[read]]  # codec was built with reversedBytes(true)
            read += 1
            bits_left = 8
        child = node[(byte >> 7) & 1]
        byte = (byte << 1) & 0xFF
        bits_left -= 1
        bits_available -= 1
        if isinstance(child, int):
            out.append(child)
            node = _ZAN_ROOT
        else:
            node = child

    return bytes(out)


def parse_zandronum(raw: bytes) -> int:
    """Parse a decoded Zandronum launcher response requesting SQF_NUMPLAYERS."""
    code = struct.unpack("<I", raw[0:4])[0]
    if code == ZANDRONUM_SERVER_IGNORING:
        # Flood protection, not an empty server. Must surface as "unknown".
        raise ValueError("server is rate-limiting queries (sv_queryignoretime)")
    if code == ZANDRONUM_SERVER_BANNED:
        raise ValueError("this host is banned from querying the server")
    if code != ZANDRONUM_SERVER_CHALLENGE:
        raise ValueError(f"unexpected zandronum response code {code}")

    offset = 8  # response code (4) + echoed time (4)
    offset = raw.index(b"\x00", offset) + 1  # version string
    flags = struct.unpack("<I", raw[offset : offset + 4])[0]
    offset += 4

    if flags & SQF_NAME:  # only present if we asked; skip it
        offset = raw.index(b"\x00", offset) + 1
    if not flags & SQF_NUMPLAYERS:
        raise ValueError("server did not return numplayers")
    return raw[offset]


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


def query_zandronum(host: str, port: int, timeout: float) -> int:
    request = b"\xff" + struct.pack(
        "<III",
        ZANDRONUM_LAUNCHER_CHALLENGE,
        SQF_NUMPLAYERS,
        int(time.time()) & 0xFFFFFFFF,
    )
    return parse_zandronum(zandronum_decode(_udp(host, port, request, timeout)))


QUERIES = {
    "a2s": query_a2s,
    "q3": query_q3,
    "gamespy": query_gamespy,
    "zandronum": query_zandronum,
}


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
