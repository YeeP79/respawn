#!/bin/sh
#
# Respawn <-> UnrealTournament.ini bridge for the modded UT99 build.
#
# Exists for the settings that have NO other durable home. The image's own
# /prepare.py maps a fixed set of UT_* env vars onto ini keys, and anything outside
# that set can only be reached by an rcon `set` — which writes the in-memory class
# default and is lost the moment the task restarts. This shim writes the ini before
# the server boots, so the setting survives a restart like every other .env value.
#
# Two settings need it today:
#
#   1. bUseTranslocator. The image bakes it per GAME TYPE, and DeathMatchPlus ships
#      False while CTFGame ships True — so deathmatch has no translocator and reading
#      CTFGame back "proves" it is on when it is not. A ?Translocator= URL option only
#      affects the game type being booted, and MVE composes its own travel URL on a map
#      change, so DM maps come back without it however the boot URL is written.
#
#   2. ServerPackages. A mutator only reaches clients if its package is listed;
#      XPickups, InstaGibPlus_10B and NoSelfDamage ship in the image but are in
#      neither the ini list nor MVE's, so their mutators cannot be used at all.
#      This has to be written in TWO places. MapVote runs with
#      bOverrideServerPackages=True, so on boot it rewrites the ini's ServerPackages
#      from its own MainServerPackages list and reloads the map. Patching only the ini
#      therefore works for exactly one map — verified on the running server, where the
#      three packages loaded on the first pass and never again after MapVote's reload.
#
# Ordering note: it writes /ut-data/System/UnrealTournament.ini, the REAL file.
# /ut-server/System/UnrealTournament.ini is a symlink to it, and /prepare.py deletes
# and recreates every symlink under System on each start — editing through the symlink
# would still land in the same file, but writing the real path is immune to that churn
# outright. /prepare.py never touches these keys, so running before it is safe, and
# that lets this shim `exec /startup.sh` rather than restate the server command (which
# would silently drift if the base image changed its flags).
set -eu

INI="/ut-data/System/UnrealTournament.ini"
# MapVote's own config. It owns ServerPackages at runtime, so an addition that is not
# also here is undone the first time MapVote reloads the map.
MVE_INI="/ut-data/System/MVE_Config.ini"

# True/False, per UE1's ini spelling. Unset leaves the image defaults alone.
UT_TRANSLOCATOR="${UT_TRANSLOCATOR:-}"
# Comma-separated packages to append to ServerPackages, for mods the image ships but
# never registers. Additive: existing entries are preserved and duplicates skipped.
UT_EXTRA_SERVERPACKAGES="${UT_EXTRA_SERVERPACKAGES:-}"

if [ -z "${UT_TRANSLOCATOR}" ] && [ -z "${UT_EXTRA_SERVERPACKAGES}" ]; then
  echo "[respawn-init] nothing to apply; leaving ${INI} untouched"
  exec /startup.sh
fi

python3 - "$INI" "$UT_TRANSLOCATOR" "$UT_EXTRA_SERVERPACKAGES" "$MVE_INI" <<'PY'
import os
import re
import sys

ini_path, translocator, extra_packages, mve_ini_path = sys.argv[1:5]

with open(ini_path, "r", encoding="latin-1") as fh:
    lines = fh.read().split("\n")

# Every game type that inherits DeathMatchPlus carries its OWN bUseTranslocator
# default — setting the parent does NOT propagate to CTFGame or Domination — so each
# is written explicitly. Assault is deliberately excluded: it ships False upstream
# because translocating past objectives breaks the mode.
TRANSLOCATOR_SECTIONS = [
    "Botpack.DeathMatchPlus",
    "Botpack.TeamGamePlus",
    "Botpack.CTFGame",
    "Botpack.Domination",
    "Botpack.LastManStanding",
]

def set_in_section(lines, section, key, value):
    """Set key=value inside [section], adding the key or the section as needed."""
    header = f"[{section}]"
    out, in_section, wrote, saw_section = [], False, False, False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            # Leaving the target section without having seen the key: add it here so
            # it lands inside the section rather than at end of file, where it would
            # belong to whatever section happens to be last.
            if in_section and not wrote:
                out.append(f"{key}={value}")
                wrote = True
            in_section = stripped.lower() == header.lower()
            saw_section = saw_section or in_section
        elif in_section and stripped.lower().startswith(f"{key.lower()}="):
            if not wrote:
                out.append(f"{key}={value}")
                wrote = True
            continue  # drop any duplicate of the same key
        out.append(line)
    if in_section and not wrote:
        out.append(f"{key}={value}")
        wrote = True
    if not saw_section:
        out.extend([f"[{section}]", f"{key}={value}"])
    return out

changed = []

if translocator:
    for section in TRANSLOCATOR_SECTIONS:
        lines = set_in_section(lines, section, "bUseTranslocator", translocator)
    changed.append(f"bUseTranslocator={translocator} on {len(TRANSLOCATOR_SECTIONS)} game types")

if extra_packages:
    wanted = [p.strip() for p in extra_packages.split(",") if p.strip()]
    existing = {
        line.split("=", 1)[1].strip().lower()
        for line in lines
        if line.strip().lower().startswith("serverpackages=")
    }
    missing = [p for p in wanted if p.lower() not in existing]
    if missing:
        # Append after the LAST existing ServerPackages line so the entries stay in
        # [Engine.GameEngine]; appending at end of file would attach them to a
        # different section and the engine would ignore them.
        last = max(
            i for i, line in enumerate(lines)
            if line.strip().lower().startswith("serverpackages=")
        )
        lines[last + 1 : last + 1] = [f"ServerPackages={p}" for p in missing]
        changed.append(f"ServerPackages += {', '.join(missing)}")
    else:
        changed.append("ServerPackages already complete")

with open(ini_path, "w", encoding="latin-1") as fh:
    fh.write("\n".join(lines))

# MapVote's MainServerPackages is the list it forces ServerPackages back to, so an
# addition missing from here survives only until its first map reload. Stored as a
# single tuple line: MainServerPackages=("A","B",...).
if extra_packages and os.path.exists(mve_ini_path):
    wanted = [p.strip() for p in extra_packages.split(",") if p.strip()]
    with open(mve_ini_path, "r", encoding="latin-1") as fh:
        mve = fh.read()

    match = re.search(r"^(MainServerPackages=\()(.*)(\))\s*$", mve, re.MULTILINE)
    if not match:
        print("[respawn-init] WARNING: no MainServerPackages line in MVE_Config.ini; "
              "extra packages will be dropped on MapVote's first reload")
    else:
        body = match.group(2)
        present = {p.strip().strip('"').lower() for p in body.split(",") if p.strip()}
        missing = [p for p in wanted if p.lower() not in present]
        if missing:
            addition = ",".join(f'"{p}"' for p in missing)
            new_body = f"{body},{addition}" if body.strip() else addition
            mve = mve[: match.start()] + f"MainServerPackages=({new_body})" + mve[match.end():]
            with open(mve_ini_path, "w", encoding="latin-1") as fh:
                fh.write(mve)
            changed.append(f"MVE MainServerPackages += {', '.join(missing)}")
        else:
            changed.append("MVE MainServerPackages already complete")

for note in changed:
    print(f"[respawn-init] {note}")
PY

exec /startup.sh
