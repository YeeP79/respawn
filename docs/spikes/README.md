# L4D2 — Spike records

One file per spike. Each records **what was actually run and what it decided**.

These exist because the L4D2 research produced a set of questions that could not
be answered by reading, and a plan that rests on several assumptions nobody has
executed. A spike closes exactly one of those, with evidence.

| Spike | Question | Blocking | Needs | Status | Answer |
|---|---|---|---|---|---|
| [S1](S1.md) | Does the full mod stack build and load together? | **Yes — first** | docker | ✅ Pass | **Yes.** MetaMod 2.0.0 + SourceMod 1.12 + Left4DHooks 1.168 + All4Dead2 + Stripper all load, zero errors, **+0.3 GB**. Two files ship broken for this game and must be removed. Entrypoint puts the rcon password in **argv** |
| [S2](S2.md) | Can the MCP drive Source rcon, and do All4Dead2's commands work over it? | **Yes** | docker + rcon | ✅ Pass *(corrected 2026-08-30)* | **Yes — no admins.cfg needed**, rcon runs as `Console<0>`. Control: a direct cheat-cvar set is refused, the plugin's is not. **12 commands, not 13.** Live-human retest corrected the split: **10 usable, 2 (`spawn_item`/`spawn_weapon`) can NEVER work over rcon** — they need a player *caller*, not a player present. `spawn_*` is instant/local, `force_*` is director-placed |
| [S3](S3.md) | Does srcds log the rcon password the way HLDS does — **and is it in argv?** | Gates go-live | docker + rcon | ⚠️ Partial | **Logs: no** — Source records `rcon from <ip>: command <cmd>`, never the credential, so **no redactor needed**. **argv: yes** — the entrypoint exposes it; avoidable via `server.cfg` + a shim |
| [S4](S4.md) | Do joining players need the custom campaign installed? | **Yes — decides the campaigns branch** | **a real client** | ❌ Fail | **Yes, they do.** The client connects fine and is admitted as **player 1**, then dies on `Host_Error: CMapLoadHelper::Init, unable to open maps/<map>.bsp`. No kick, no warning — it fails *after* joining. Campaigns are a **branch**, not a knob |
| [S5](S5.md) | Is the slot machinery inert at four players? | Decides base membership | docker | ✅ Pass | **Yes** — identical to base at defaults, and `sv_maxplayers` resizes a running server live. Must use the **`oldlinux`** build; the plain one fails on glibc and leaves a server with no slot support |
| [S6](S6.md) | What must the fifth player actually do to join? | Defines the big-coop ritual | **two players** | ⬜ Not started | — |
| [S7](S7.md) | What does the modded image weigh, and how much ephemeral storage does it need? | ~~gates the CDK change~~ | docker | ✅ Pass | **~10.4 GB, not 15.6** — `docker images` reports 50% high. Fargate's default leaves **10 GiB headroom**, so `ephemeralStorage` is **not a blocker**. Mods add 221 MB |
| [S8](S8.md) | Does ECR duplicate the base layers across repositories? | No — informs branch-vs-knob | AWS read | ✅ Pass | **Yes today** — `BLOB_MOUNTING` is DISABLED, so 1.30 GB is duplicated. **But the whole registry costs ~19c/month**, so cost is not an argument either way. One setting fixes it |
| [S9](S9.md) | Can `sv_downloadurl` deliver a campaign to a client that lacks it? | No — decides how harsh the client ritual is | FastDL host + **a real client** | ❌ Fail | **No, and it does not try.** With a populated FastDL host advertised, the client issued **zero HTTP requests** and failed identically. Silence rules out path/compression/filter causes — the code path is never entered. Subscribing is mandatory; **no FastDL bucket for campaigns** |
| [S11](S11.md) | Does the full 40+ plugin stack load together? | Yes — gates the modded variant | docker | ✅ Pass | **49/50 plugins, 12/13 extensions.** Three findings: **Accelerator fails** (`GLIBCXX_3.4.21`) and only the new log shipper caught it; the **slot machinery is half-loaded** (`sv_maxplayers` yes, `sv_removehumanlimit` no); and the curated pack ships a **different All4Dead2** — fbef0102's fork has **7 commands vs AtomicStryker's 12**, missing `reset_to_defaults`. **Keep ours** |
| [S10](S10.md) | Does a server-side VScript addon work without the client installing it? | ~~Yes~~ — answered | S1 rig + **a real client** | ✅ Pass | **Yes, and fully drivable.** The blocker was never the client: `Left4Lib` auto-promotes a player to Admin **only on a listen server** (`Director.IsSinglePlayerGame()`), so on a dedicated one everyone is level 0 and every order is dropped **silently** — no message, no log line. One line in `ems/left4lib/cfg/admins.txt` fixes it. L4B goes in the base |

Status key: ⬜ Not started · 🟡 In progress · ✅ Pass · ❌ Fail · ⚠️ Partial

## Where this stands

**Eight of nine are done (S1-S5, S7, S8, S9 · S4 and S9 closed 2026-08-30).**
Everything answerable without a game client is answered, and both questions that
needed one solo have now been answered by one.

**S4 came back FAIL, and it settles the campaigns branch.** A player who has not
installed the campaign connects successfully, is admitted as player 1, and *then*
dies on `Host_Error: CMapLoadHelper::Init`. The failure is after the join, not at
the door, and nothing tells the player what is wrong — so a custom campaign on
the shared server silently breaks it for everyone who has not subscribed. Custom
campaigns get their own service, and the client ritual is the reason it is
separate.

**S9 came back FAIL too, and it closed the last escape hatch.** S4 deliberately
did not generalise from an empty `sv_downloadurl` to "no download path can work",
so S9 built one: 166 loose files served over HTTP, the exact `.bsp` URL verified
with `curl` first. The client issued **zero HTTP requests** and failed exactly as
before. That is a stronger result than a failed download — every mundane cause
(wrong path, missing `.bz2`, client filter, MIME type) produces a *request*.
Silence means the code path is never entered. So the client ritual cannot be
softened, and a FastDL bucket for campaigns would be infrastructure nothing reads.

**S6 alone remains**, and it needs two players.

**S10 closed ✅** — and the answer was not the one every symptom pointed at. A VScript
addon runs *and is drivable* on a dedicated server; what silently blocked every order
was `Left4Lib`'s permission system, which auto-promotes a player to Admin only when
`Director.IsSinglePlayerGame()` is true. The Workshop's entire audience plays listen
servers, where that is always true — so the addon "obviously works" for everyone
except a dedicated host, who gets no error of any kind. One line in
`ems/left4lib/cfg/admins.txt` is the whole fix, and it becomes a per-server deploy
requirement with a fail-silent failure mode.

S6 is otherwise unchanged, though S4 fed it a useful fact: `sv_allow_lobby_connect_only` is a **server** cvar governing direct connection,
which is evidence that lobby reservation is adjustable server-side and that
big-coop may still collapse from a branch into a knob.

Both spike images are built locally. Recipes are `lab/s1-modded-image/` and
`lab/s5-slot-machinery/`; `lab/srcds-rcon.py` is the Source rcon client they use,
and `lab/s4-campaign/` holds S4's campaign VPK.

**Five of the eight overturned something they were built on**, which is the whole
argument for running spikes rather than reasoning from the research:

- **S7** — the image is 10.4 GB, not the 15.6 GB `docker images` reports. That
  removed the ephemeral-storage blocker entirely.
- **S8** — registry duplication is real, and costs about 19 cents a month. That
  retired the cost argument for preferring knobs over branches.
- **S2** — 12 commands, not 13, and five of them need a client present, on a
  server that is empty most of its life.
- **S4** — the walkthrough that never mentions the client was wrong by omission,
  and the "consistency conflict" sources were right. It also found that a server
  answering A2S perfectly can be one no client can join.
- **S9** — retired its own proposed follow-up. Re-testing on MinIO or a real S3
  bucket would have validated the URL shape of a transport the client never
  contacts; a zero-request result cannot be changed by changing the host.

**The original order, for reference.** S1 first, because everything except S8
needed a modded server to exist and S1 was what found out whether the base
template was real at all. Then the cheap server-side ones (S2, S3, S5, S7) in any
order on the same container, with S8 runnable at any time since it depended on
nothing.

## What a live human is needed for

S1-S3, S5, S7 were run with **bots or an empty server**, and S2's follow-up shows
what that costs: three of its conclusions were wrong, and the errors all pointed
the same way — toward a manifest advertising commands that cannot work. Bots
satisfy `Misc_GetAnyClient()`, so they prove *presence* and nothing about a
*caller*.

Things only a connected human has settled so far:

- `spawn_item`/`spawn_weapon` are permanently unavailable to rcon (S2 follow-up)
- All4Dead2's spawns route through `z_spawn` and honour its placement cvars
- Player-facing notifications actually reach chat
- **A2S reports `PLAYERS=1` for a real human** — so the fleet-wide
  `IDLE_CHECK_METHOD=a2s` watchdog will not scale a populated server to zero.
  This is the one finding here that is not L4D2-specific
- The `apps/l4d2` manifest shipped two non-functional cvars (`mp_gamemode` does
  not exist on this build; `director_no_specials` is `FCVAR_CHEAT` and refused
  whenever `sv_cheats` is 0). Both removed

Still needing one: `kick` by player name, `force_tank`/`force_witch` actually
arriving, and `sv_maxplayers` resize with an occupant (that one needs the **S5**
image — `sv_maxplayers` comes from L4DToolz and does not exist in the S1 base).

## Three ways to get a wrong answer with a real client

S4 hit all three, and each produces a **confident wrong result** rather than an
error. Anything needing a client — S6, S9 — inherits them.

- **Steam restores unsubscribed Workshop files on its own, with the game closed.**
  Moving a VPK aside does not make a client lack a campaign. A test built that way
  passes for the wrong reason. Use content that was **never subscribed**;
  `steamcmd +login anonymous +workshop_download_item 550 <id>` fetches it without
  touching any account, and the `_legacy.bin` it writes *is* the VPK.
- **`docker-proxy` breaks the Source connect handshake while passing A2S.** Publish
  a port and every health check succeeds while no client can connect. Address the
  container's bridge IP and its own port instead (`172.17.0.2:27015`, not the
  published one). `--network host` is not the fix — the container's Steam collides
  with the host's and breaks A2S too.
- **A2S is not a joinability check.** It measures population. The fleet's
  `IDLE_CHECK_METHOD=a2s` probes are correct for what they do and prove nothing
  about whether anyone can get in.

## Where the pass bars live

Blueline keeps its method and pass criteria in a central kickoff document and
forbids restating them in the spike, so there is exactly one copy to keep true.
**These do not**, deliberately: respawn has no equivalent central spec, and
inventing one to hold eight pass bars would be indirection with nothing on the
other end. Each spike carries its own bar. If that stops being true — if a
standing L4D2 design document appears — move them and leave a pointer.

## Almost all of this is free

Eight of the nine run against a **local `docker run`**, not a deployed service.
That is deliberate: it matches how the GoldSrc work was verified, it keeps the
answers reproducible, and it costs nothing while every server sits scaled to
zero. S4, S6 and S9 need a real client — but S4 proved that is still a local
`docker run` plus the game on the same machine, not a deployment — and S8 is a
read-only AWS query.

## The rule that makes this work

**A spike that hits a blocker spawns a spike.** Do not widen a spike to swallow
the new question — record the blocker, open a new file, and let the ledger show
that the question arose from evidence rather than from planning.

**A failed spike is a successful outcome.** The point is to close a direction
before it costs a rebuild. S4 exists precisely because two sources disagree, and
either answer is useful — it came back ❌ and is the most valuable result in the
ledger, because it closed the campaigns question before anything was built on the
wrong side of it.

## What these already saved

The research phase produced two errors that a spike-shaped habit would have
caught earlier, and both are recorded in the spikes that now cover them:

- A guide about **local listen servers** was read as applying to dedicated ones,
  which put a phantom `-insecure` requirement on every player and would have
  forced an unnecessary branch.
- All4Dead2 was described everywhere as **"menu-driven"**, which would have made
  it useless to an MCP. Reading its source found 13 registered console commands.
  The description was wrong; the code was not.

Both are why `template.md` insists you say whether you **read** a source.
