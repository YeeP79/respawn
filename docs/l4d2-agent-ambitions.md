# L4D2 — what an agent could do with this server

A parking place for ideas that are worth trying but are not the build. Each one
says what it needs and how confident the claim is, because the difference between
"measured", "read in source" and "I reasoned it should work" is what this project
keeps getting bitten by.

Ordered by how close it is to working, not by how exciting it is.

Confidence: **measured** = observed on a live server · **source** = read in the
project's own code · **inferred** = reasoned from the above, never run.

---

## 1. Scenario skills — `/turn-up-the-heat` and friends

**Confidence: measured.** Everything this needs was verified 2026-08-30 with a
human on the server.

A skill that sequences director commands into an escalation with pacing. The
primitives and their behaviour are known:

| | Timing | Placement |
|---|---|---|
| `a4d_spawn_infected <type>` | instant | near a player, via `z_spawn` |
| `a4d_spawn_uinfected <type>` | instant | near a player, own entity path |
| `a4d_force_panic` | instant | horde event |
| `a4d_force_tank` / `_witch` | next director beat | director's choice, ahead on the map |
| `a4d_add_zombies <0-99>` | ambient | — |

`spawn_*` is for beats you want **now**; `force_*` is pressure that arrives on its
own schedule. A skill that treats them alike will feel arbitrary.

Two constraints, both measured: `spawn_item`/`spawn_weapon` **cannot** be driven
over rcon at all, and `a4d_enable_notifications` decides whether the skill narrates
its own sabotage in player chat. Silent is almost certainly what "turn up the heat"
wants; announced suits a dungeon-master mode.

`a4d_reset_to_defaults` is the safety valve and restores everything in one call.

---

## 2. The control loop — antagonist and difficulty governor at once

**Confidence: measured on both halves, never wired together.**

The agent can read the room (`status`, `server_logs`, `server_health`) and write to
**two independent surfaces**:

- **All4Dead2** — how much pressure exists
- **`ib_*` cvars** — how competent the survivor bots are

That second one is the interesting half and it only became available with the bot
plugin. It means the agent is not merely making things harder; it is deciding
whether the team can cope, which is the actual job a human game master does.

Concretely: drop `ib_grab_distance` and raise `ib_evade_*` when the team is hurt so
bots play conservatively; invert it for a confident push. Or let
`/turn-up-the-heat` dull the bots *as* it spawns, so the difficulty curve moves
from both ends.

**The honest limit.** Bot tactics need sub-second reactions and an rcon round trip
is seconds. The Left4Bots author is blunt that the AI is `if/then/else` with no
learning — and that is the right layer for twitch decisions. The split that works:

> **Plugin owns tactics** (dodging, shooting, pathing — fast, local, deterministic).
> **Agent owns posture** (how cautious, how greedy, how much pressure — slow,
> contextual, and exactly what `if/else` cannot do).

Selling it as "AI-powered bots" would be a lie. Selling it as an agent that reads a
run and adjusts its shape is true and better.

---

## 3. Agent as squad commander

**Confidence: MEASURED (S10, 2026-08-30) — the orders work; the agent cannot issue
them directly and needs a bridge.**

Two findings, and the second one is the constraint:

**a) The order surface works on a dedicated server.** Verified live: `!l4b bots wait`
from a player put every bot on `wait`, visible in L4B's own order HUD
(`Coach: [->] wait () (DestPos) - 0 ()`). This needed one non-obvious thing — the
player's SteamID in `ems/left4lib/cfg/admins.txt` — because Left4Lib auto-promotes to
Admin **only when `Director.IsSinglePlayerGame()`**, and rejects everyone else
*silently*. See S10.

**b) rcon cannot drive it.** From `left4bots_events.nut`:

```squirrel
::Left4Bots.HandleCommand <- function (player, cmd, args, text)
{
  if (!player || !player.IsValid() || IsPlayerABot(player)
      || Left4Users.GetOnlineUserLevel(player.GetPlayerUserId()) < Settings.userlevel_orders)
    return;
```

rcon is `Console<0>` with **no player entity**, so `!player` returns before permissions
are consulted. No admin entry fixes this; it is structural. The console form in
`COMMANDS.md` is documented next to `bind "KEY" ...` — it is a *keybinding* for a
player, not a remote API, and reading it as one was an error corrected here.

**The bridge is BUILT and WORKING** — `apps/l4d2/plugins/respawn_director.sp`,
verified end to end 2026-08-30. It registers admin commands (rcon satisfies
`RegAdminCmd` as `Console<0>`, per S2), finds a connected human, and replays the order
as them:

```c
FakeClientCommand(human, "scripted_user_func l4b,%s,%s", botsource, cmd);
```

The `FakeClientCommand`-carries-`scripted_user_func` step was the one inferred link;
it is now measured. Live:

```
> sm_rd_order coach lock
OK|sent|as=YeeP|cmd=scripted_user_func l4b,coach,lock
```

and Coach locked onto the player's target. The degenerate case needs no handling:
orders only matter when somebody is playing, and then there is always a player to
impersonate — reported honestly as `ERR|no_human` rather than a generic failure.

**Settings ride the same path**, because L4B routes them through the same handler —
so one command surface covers the whole order vocabulary *and* ~200 live-tunable
knobs. The agent can even enable its own debug HUD:
`sm_rd_order settings orders_debug 1`.

So §3 and §4 collapse into **one plugin** — it was already the answer for spawn
placement, and it is the answer for bot orders and settings too.

**Also now reachable, and needing no bridge at all:** ~200 L4B settings are live
read/write from chat for any admin (`!l4b settings <name> [value]`,
`!l4b findsettings <text>`). Mid-game, no restart. That is what makes iterating on bot
behaviour practical, and it is the posture half of the control loop in §2.

This is the closest thing to *playing* that is realistically reachable, and it
changes which bot project we would want.

L4D2's VScript exposes **`CommandABot()`** — the native that directs a specific bot
to move to a position, attack a target, or retreat. It is how Left 4 Bots 2
implements its whole order system (lead, follow a named survivor, hold a position).

The order vocabulary is documented and richer than expected — every one of these is
rcon-reachable as `scripted_user_func l4b,<botsource>,<command>[,<param>]`, where
botsource is `bot` (crosshair), `bots` (all), or a bot's name:

| Order | What the bot does |
|---|---|
| `follow [target]` · `come` · `goto [target]` | movement, relative to you or a named survivor |
| `wait [here\|there]` | hold position — current, yours, or where you are looking |
| `lead` | lead the way along the map flow |
| `lock` | shoot **whatever you shoot**, until cancelled |
| `heal [target]` · `tempheal` · `give` · `swap` | medical and inventory |
| `carry` · `scavenge` · `deploy` · `use` · `destroy` | objects and objectives |
| `witch` | kill the witch you are looking at |
| `throw [item]` | throwable, at where you are looking |
| `hurry` | drop everything and move for N seconds |
| `warp [here\|there]` | teleport (admin-ish, but exists) |
| `cancel [current\|type\|all]` | unwind the queue |

Orders go into a **priority queue** (carry/follow/lead/scavenge 0, goto/wait 1,
deploy/heal/use/destroy 2, witch 3); higher priority runs first, and the next order
waits for the current one to finish or be cancelled. So an agent issuing several
orders is scheduling, not just firing commands.

**This is a genuine argument for revisiting Left4Bots**, and it cuts against the
choice in `mods/mods-bots.txt`:

| | Bot AI Improver (chosen) | Left 4 Bots 2 (rejected for base) |
|---|---|---|
| Surface | ~40 `ib_*` cvars | orders + settings |
| Agent can | tune **posture** | issue **orders** |
| Server-side | yes, by construction | **unverified (S10)** |

The Improver is autonomous with no command surface — you can make the bots
*generally* braver, not tell one to go left. For the commander ambition, L4B2 is the
right tool and its blocker is S10.

They **conflict** and cannot both run, so this is a swap, not an addition.

---

## 3b. Vocalizer as a command channel — "Coach, I need help"

**Confidence: source. Mostly already built.**

L4D2's vocalizer is UT99's voice menu: ~40 canned lines on a radial, each a console
command (`vocalize PlayerHelp`). **L4B2 already binds vocalizer lines to bot
orders**, and the table is user-editable at `ems/left4bots2/cfg/vocalizer.txt`:

```
<vocalizer command> = <l4b2 command1>,<l4b2 command2>
```

`command1` fires when no bot is selected; `command2` after selecting one, where the
keyword `botname` is substituted. Bot selection is `botselect` — nearest to your
crosshair, bindable to a key, because the vanilla "Look" vocalizer line is
documented as unreliable (it often says "Weapons here" instead).

Shipped defaults already cover lead / wait / goto / witch / follow me / heal me.

**What is NOT there is a protect order**, which is the interesting half of the idea:
*put yourself between me and trouble.* Nothing in the vocabulary expresses it. Three
ways to get it, cheapest first:

1. **Compose it.** `botname wait here` plants a bot on your position and `lock`
   makes it shoot what you shoot. Together that is roughly a bodyguard, and it is
   pure config — a `vocalizer.txt` edit, no code.
2. **Write it** as a real order in `left4bots_afterload.nut`, which overrides single
   L4B2 functions without forking so the base addon keeps updating underneath. This
   is where "stand between the player and the nearest threat" would actually live —
   it needs a threat position, which composition cannot see.
3. **Agent-mediated**, for the version config cannot reach — BUILT, see below.

**Why this belongs as a plugin and not an agent.** "Protect me *now*" is a reflex,
and an rcon round trip is seconds. The vocalizer path is local and instant. Do not
route a panic button through a language model.

**Where an agent genuinely adds something: chat, not the vocalizer.** The radial is
a fixed set of ~40 lines; typed chat is arbitrary natural language, and parsing
*"coach hold the left door while I get the gascan"* into a `goto` + `wait` + a
scavenge order is exactly what an LLM does and a binding table cannot. The latency
that disqualifies it for reflexes is fine for tactical instructions. Chat is already
readable server-side (`fbef0102/savechat` does it), so the channel exists.

That is the honest division: **vocalizer for reflexes, chat for intent.**

### Built and measured, 2026-08-30

The chat-for-intent half now works end to end. `respawn_director` captures chat
prefixed with `@` into a ring buffer the agent drains over rcon — deliberately NOT by
reading server logs, which proved unreliable during S10 (stdout echo died mid-session
and took four readings with it). The plugin owns the inbox, so nothing outside it can
break the channel.

```
you        @coach shoot what I shoot          (plain English, in game chat)
plugin     MSG|2|YeeP|STEAM_1:1:14886575|coach shoot what I shoot
agent      maps intent onto the order vocabulary  ->  lock
bridge     FakeClientCommand(YeeP, "scripted_user_func l4b,coach,lock")
L4B        order accepted; Coach locks onto the player's target
```

Design notes worth keeping:

- **Prefix-filtered server-side.** Only `@`-prefixed chat is captured, so ordinary
  table talk never reaches the agent's context. Widening it is one `strncmp`.
- **Ring buffer, oldest dropped.** If the agent has not drained for a while, the
  NEWEST intent is the one still relevant.
- **Drained on read, at-most-once.** A message is delivered once; the agent is
  responsible for acting on it.
- **The vocabulary is finite and an LLM will exceed it.** "Guard the door" has no
  order. The agent must know the vocabulary and say *"I can't do that, here is the
  nearest thing"* rather than sending something approximate — the same
  run-what-the-service-declares rule the rcon manifests already follow. That belongs
  in the manifest, not the plugin.

---

## 4. `respawn-director` — our own SourceMod plugin

**Confidence: source.** The mechanism is five lines, read out of All4Dead2:

```c
new flags = GetCommandFlags(command);
SetCommandFlags(command, flags & ~FCVAR_CHEAT);
FakeClientCommand(client, "%s %s", command, arguments);
SetCommandFlags(command, flags);
```

Strip the cheat flag, run the command, restore it. `sv_cheats` is never touched, so
players get nothing. An admin-registered command (`RegAdminCmd`, which rcon
satisfies as `Console<0>`) can therefore do things All4Dead2 does not expose:

- **Placement as a real argument.** Verified live that `z_spawn_const_distance`
  steers All4Dead2's spawns, because it routes through `z_spawn` underneath. A
  plugin could set `z_spawn_const_pos`, spawn, and restore — "put a tank *there*".
- **Resurrect `spawn_item` / `spawn_weapon`.** They fail only because they call
  `give`, which refuses a console caller. Creating and teleporting the entity —
  the way the uncommon-infected path already works — sidesteps that entirely.
- **Deterministic spawns for testing**, rather than `auto` placement.

Cost is honest: a compiled `.smx` we own and pin. `spcomp64` is already in the S1
image and already gates a compile failure with `test -f`, so the toolchain exists.

---

## 5. Improving the bot code itself

**Confidence: source.** Deliberately *after* running what exists.

Both projects are extensible without forking:

- **Left4Bots** reads `left4bots_afterload.nut` and `left4bots_afterinit.nut` from
  the vscript directory and calls them at defined points, so you override single
  functions and the base addon keeps updating underneath you. Its author documents
  this as the supported path and warns against duplicating the files.
- **Bot AI Improver** is plain SourcePawn we already have a compiler for.

Start by running theirs, tuning cvars, and finding out what actually annoys us.
An improvement nobody has felt the absence of is a guess.

---

## 6. Agent as an actual player

**Confidence: inferred, and the honest answer is "not like this".**

Occupying a survivor slot and playing is a different architecture, not a harder
version of the above. Rcon has no input channel — movement is not a console
command — so the options are:

- **Drive a real game client** (input injection, screen reading). This is how a
  human plays and it is a whole project, unrelated to everything else here.
- **`CommandABot` via VScript** — reaches *orders*, not per-frame input. That is
  §3, and it is the achievable version.

The latency wall is the same one from §2: seconds per round trip against a game
that needs sub-second reactions. **Commanding is reachable; playing is not**, and
the distinction is worth keeping sharp so nobody builds toward the wrong one.

---

## Open questions these depend on

- ~~**S10** — can a VScript addon be server-side only?~~ **Answered ✅**: yes, and
  fully drivable. The blocker was Left4Lib's permission system, not the client.
- **S6** — the fifth-player ritual; needs two humans.
- ~~Whether `scripted_user_func` reaches L4B2's order functions~~ — **answered**
  from `COMMANDS.md`: it does. Still unrun against a live server.
- ~~Whether the `ib_*` cvars behave as documented~~ — moot; the Bot AI Improver was
  dropped once S10 unblocked Left 4 Bots, and the two conflict.
- Whether `FakeClientCommand` successfully carries `scripted_user_func` to L4B's
  handler. The pattern is proven for `z_spawn`; this specific target is **inferred**
  and is the one thing the bridge plugin rests on. Test it first.
