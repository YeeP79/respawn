# MCP tooling gaps, as evidenced by the L4D2 spikes

Every entry here was **produced by a spike going wrong**, not by imagining what might be
useful. Each names the incident, what it cost, and what would have shortened it. Where a
gap is speculative or L4D2-only, it says so — a wishlist that does not distinguish measured
pain from good ideas is a wishlist nobody can prioritise.

Ordered by evidence strength, not by effort.

---

## 1. Nothing can answer "can a player actually join?"

**Incident — S4, 2026-08-30.** Four consecutive connection attempts failed over roughly an
hour. Throughout, every server-side signal was green: rcon responded, `status` reported a
healthy server on the right map, and **A2S answered every query**. The cause was
`docker-proxy` breaking the Source connect handshake while passing A2S cleanly.

**Why this is the worst gap.** A2S is a single request/response; a game connection is a
stateful multi-packet handshake. A transport can pass the first and fail the second, and
today *nothing in the fleet distinguishes them*:

- `server_health` reports container and process state
- `IDLE_CHECK_METHOD=a2s` counts players
- `describe_transport` reports what rcon speaks

All three were correct and all three were useless, because none answers the question a
player asks. Worse, this is not a lab-only concern — a security-group rule, a task
networking change, or a load balancer could produce exactly this shape in the deployed
fleet: **a server that monitors perfectly and that nobody can join.**

**Proposed:** `can_join(service)` — perform the real handshake (challenge → connect), report
reached-or-not with the failure stage, and explicitly do **not** reuse the A2S path.

**Generalises:** yes, to every game in the fleet. This is the highest-value item here.

**Corollary already recorded in S4:** never verify reachability with A2S alone. The
existing `IDLE_CHECK_METHOD=a2s` probes are correct for what they measure — population —
and were never intended to prove joinability. The bug would be reading them as if they did.

**Measured 2026-08-30, with a real human connected:** A2S returned `PLAYERS=1`, agreeing
with rcon's `status`. So the population half is sound and the fleet's idle watchdog will
**not** scale a populated server to zero — worth stating positively, because it is the
property everything else here depends on. It also sharpens the gap rather than closing it:
A2S counts players correctly *and still cannot tell you whether anyone can get in*. Those
are different questions, and only one of them has a tool.

An earlier reading of `PLAYERS=0` was taken seconds after the player had disconnected and
is **void, not a finding** — recorded here because reporting it would have manufactured a
fleet-wide bug out of a mistimed probe.

---

## 2. `set_cvar` does not verify the value took

**Incident — S9, 2026-08-30.** Setting `sv_downloadurl http://127.0.0.1:8099/` over raw rcon
stored **`"http:"`** — srcds parses `//` as a comment. The command reported success. The
truncation was found only by reading the value back by hand.

**What the MCP already does right:** `resolveCvarCommand` emits `<name> "<value>"`, so
`set_cvar` would not have hit this specific truncation. That is a real existing protection
and should not be re-implemented.

**What is still missing:** confirmation. Quoting prevents one known mangling; it does not
prove the server accepted, clamped, or even recognised the value. A cvar that does not exist,
is rejected as a cheat, or is silently clamped to a range all currently look like success.

**Proposed:** `set_cvar` reads the cvar back after writing and reports
`requested` vs `actual`, flagging a mismatch. For an unknown cvar the read-back is empty —
which is itself the answer, and is how S4 established that `sv_allowdownload` does not exist
on this build.

**Generalises:** yes. Cheap, and it converts a class of silent failures into loud ones.

---

## 2b. Nothing checks a manifest against the server it claims to describe

**Incident — 2026-08-30.** `apps/l4d2/rcon-manifest.json` shipped **two of its four cvars
non-functional**, and its own `notes` field admitted "not yet verified against a live
server". Verifying took about ninety seconds once a server was up:

- `mp_gamemode` — **does not exist on this build.** `find gamemode` returns nothing. The
  mode is set by `change_mode_and_map` (`map <map> <mode>`), confirmed by the slot count
  moving 4 → 8 on versus.
- `director_no_specials` — `FCVAR_CHEAT`, so it is refused whenever `sv_cheats` is 0,
  which is always on a real server.

Both are now removed. But nothing would have caught them: a manifest is data, the MCP runs
what it declares, and a declared-but-dead entry fails only when somebody tries it — as a
runtime error that reads like a transient problem rather than a wrong file.

**Proposed:** `verify_manifest(service)` — for each declared cvar, read it back and report
unknown / cheat-gated / settable; for each command, report whether its verb resolves. Run
against a live server it is a conformance check; the same pass would have found these two
before they shipped.

**Generalises:** yes. Ten games carry manifests, all written from documentation. This one
was wrong in two places out of four, and it is the only one anybody has checked.

---

## 3. No way to see what content a server actually has mounted

**Incident — S4.** Answering "does this server really have the campaign" meant writing a VPK
directory parser and reading the mission file by hand to find the start map. The server
itself knew the whole time.

**Already available over rcon, and surfaced by nothing:**

```
show_addon_load_order     - Display's the load order for custom addon files.
show_addon_metadata       - Display's the collected metadata for custom addon files.
update_addon_paths        - Reloads the search paths for game addons.
unload_all_addons         - Unloads all addons and addon search paths.
l4d2_addons_eclipse       - Addons Manager (-1 addonconfig / 0 disable / 1 enable)
```

**Proposed:** extend `check_content` (or add `list_content`) to report mounted addons and
the maps they provide. `check_content` is already the "is this service's content coherent"
tool and already delegates to per-service scripts, so this fits its existing shape rather
than adding a concept.

**Generalises:** partly. The rcon commands are L4D2-specific, but the *question* is not —
`tfc` has the same one about maps and wads, and Valheim has it about plugins. The
per-service-script pattern already handles that variation.

---

## 4. A service cannot declare what the CLIENT must install

**Incident — S4 and S9 together.** Both failed, from opposite directions: a player without
the campaign joins successfully and *then* dies on `Host_Error`, and `sv_downloadurl` cannot
fix it because the client never even requests the file. So a campaign service has a hard
client-side prerequisite — and there is nowhere to write it down.

**Today** this can only live in `SERVICE_DISPLAY_NAME`/`SERVER_NAME` prose, which is where
the Valheim crossplay exclusion lives. That works because it is one sentence. "Subscribe to
these four Workshop IDs" is not one sentence, and prose cannot be checked.

**Proposed:** per-service client requirements as **data**, the same way `rcon-manifest.json`
makes the control surface data and `mods.lock` makes the Valheim plugin set data — surfaced
by `list_services` and `get_server_options` so the requirement travels with the server rather
than living in someone's memory.

**Generalises:** yes, and this is the one with reach beyond L4D2. Valheim already has this
shape (`mods.lock` is the list a player's modpack must match) and expresses it separately.
A shared notion of "what a joiner needs" would cover both.

**Honest caveat:** this is a design proposal, not a measured gap — nothing was *lost* to its
absence today, because the spikes were the thing discovering the requirement. It earns its
place because S4's failure mode is a successful join followed by a crash, which is the worst
possible shape for an unstated prerequisite.

---

## 5. Cvar discovery is possible but not discoverable

**Incident — S4.** `find download` over rcon is what established that `sv_downloadurl` is the
*only* download-related cvar, and that `sv_allowdownload`/`sv_allowupload` do not exist. That
negative result is load-bearing evidence in both spike records.

`rcon` (the raw escape hatch) can already do this, so this is a **discoverability** gap, not a
capability one. Worth stating plainly rather than filing as missing functionality.

**Proposed:** a thin `find_cvars(service, pattern)`, or simply naming `find` in the `rcon`
tool description as the way to ask what a build supports.

**Generalises:** to the Source/GoldSrc families that have `find`. Not universal.

---

## 6. The local spike harness is tribal knowledge

Running a spike server that a real client can join now requires knowing three
non-obvious things, all learned the hard way and currently recorded only in prose in S4:

- publish no port — address the container's **bridge IP** and its own port
- `--network host` is not the fix; it collides with the host's Steam and breaks A2S too
- `sv_allow_lobby_connect_only 0` is required before any direct connect

**Proposed:** fold into `lab/` as a script beside `srcds-rcon.py`, so S6 and any future
client-involving spike starts from a working rig.

**Generalises:** no — this is spike infrastructure, not fleet tooling. Listed because it is
cheap and the next spike pays the cost otherwise.

---

## What this list deliberately does not include

- **A FastDL/MinIO harness for campaigns.** S9 retired it: the client issues zero HTTP
  requests, so no transport change can matter. Building it would be infrastructure nothing
  reads.
- **Anything about the rcon password in argv.** Real, but already recorded as S3's finding
  with a known remedy (`server.cfg` + a shim); it is a service change, not a tool.
