# L4D2 mod manifests

Same mechanics as `apps/valheim`: tracked `mods-*.txt` tiers, `include` for shared
sets, and a generated-and-committed `mods.lock` per variant so the effective set is
reviewable and a rebuild is reproducible.

**Three things differ from Valheim, and they are why this is not a copy.**

### 1. There is no world, so there is no `world-safe`

Valheim's flag exists because a mod-created prefab is written into a save that
outlives the server, making the change one-way. L4D2 keeps nothing between
sessions — every map load starts clean — so no plugin here can make a permanent
change to anything. Removing a plugin costs nothing but the feature.

The flag that replaces it is **`client-side`**, and it is the only one that
matters: it marks an entry a joining player must install themselves.

### 2. One package can land in four directories

Valheim mods are all plugin DLLs, so a flat list suffices. SourceMod artifacts are
routed by file type, and a single package may ship several:

| Artifact | Destination |
|---|---|
| `.smx` | `addons/sourcemod/plugins/` |
| `*games.txt`, `l4d2*.txt` | `addons/sourcemod/gamedata/` |
| `*phrases.txt` | `addons/sourcemod/translations/` |
| `.so` / `.dll` (extension) | `addons/sourcemod/extensions/` |
| `.cfg` | `cfg/sourcemod/` |
| `.vdf` | `addons/` (MetaMod loader stub) |
| `.vpk` | `addons/` (VScript addon or campaign) |

So an entry carries a `kind:` telling the fetcher what shape it is. A `.sp` entry
is compiled at build time with `spcomp64`, which the S1 image already does for
All4Dead2 and gates with `test -f`.

### 2b. Prefer a SourceMod plugin over a VScript addon, all else equal

A `.smx` is server-side by construction. A VScript addon ships as a Workshop VPK
and its client cost is an open question (S10). Where both exist for the same job,
the plugin is base-eligible today and the addon is not — which is exactly why
`mods-bots.txt` chooses the less popular of the two bot projects. Popularity is a
weaker signal than "can this be in the base at all".

### 3. `client-side` is measured, not asserted

Valheim's `world-safe` is an operator judgement nothing can check. Here S4 and S9
made the equivalent question empirical: a client that lacks a campaign connects,
is admitted as a player, and dies on `Host_Error: CMapLoadHelper::Init`, and the
server cannot push it (`sv_downloadurl` produced **zero** HTTP requests; there is
no `host_workshop_*`, no `ugc`, no `sv_allowdownload`).

**But the finding is about maps, and does not generalise to every VPK.** A VPK
containing only server-side VScript is a different case and is currently
**unverified** — see `left4bots` below. Do not mark anything `client-side` on the
grounds that it ships as a VPK; mark it because its content has to exist on the
client.

## Format

```
<kind>:<locator> <version> [client-side]
```

`kind` is one of `sm` (SourceMod plugin, prebuilt `.smx`), `sp` (SourcePawn source,
compiled at build), `mm` (MetaMod plugin), `ext` (SourceMod extension), `ws`
(Workshop VPK), `pkg` (tarball rooted at `addons/`).

## Provenance of the versions below

Versions marked **(pack)** come from `SNWCreations/l4d2-modded-server`'s pinned
table — second-hand, and its pins are *older* than ours where they overlap
(Left4DHooks 1.161 vs our 1.168, SourceMod git7221 vs our git7251). Treat them as
a known-good floor, not as current.

Versions marked **(read)** were read from the project's own repository.

**Nothing here has been loaded together.** S1 proved the four platform pieces plus
All4Dead2 and Stripper co-exist; everything else in these files is unexercised and
wants an S1-shaped build test before it is believed.
