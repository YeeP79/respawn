# L4D2 — Spike records

One file per spike. Each records **what was actually run and what it decided**.

These exist because the L4D2 research produced a set of questions that could not
be answered by reading, and a plan that rests on several assumptions nobody has
executed. A spike closes exactly one of those, with evidence.

| Spike | Question | Blocking | Needs | Status | Answer |
|---|---|---|---|---|---|
| [S1](S1.md) | Does the full mod stack build and load together? | **Yes — first** | docker | ✅ Pass | **Yes.** MetaMod 2.0.0 + SourceMod 1.12 + Left4DHooks 1.168 + All4Dead2 + Stripper all load, zero errors, **+0.3 GB**. Two files ship broken for this game and must be removed. Entrypoint puts the rcon password in **argv** |
| [S2](S2.md) | Can the MCP drive Source rcon, and do All4Dead2's commands work over it? | **Yes** | docker + rcon | ✅ Pass | **Yes — no admins.cfg needed**, rcon runs as `Console<0>`. Control: a direct cheat-cvar set is refused, the plugin's is not. **12 commands, not 13**; 5 of them need a client present (bots count) |
| [S3](S3.md) | Does srcds log the rcon password the way HLDS does — **and is it in argv?** | Gates go-live | docker + rcon | ⚠️ Partial | **Logs: no** — Source records `rcon from <ip>: command <cmd>`, never the credential, so **no redactor needed**. **argv: yes** — the entrypoint exposes it; avoidable via `server.cfg` + a shim |
| [S4](S4.md) | Do joining players need the custom campaign installed? | **Yes — decides the campaigns branch** | **a real client** | ⬜ Not started | — |
| [S5](S5.md) | Is the slot machinery inert at four players? | Decides base membership | docker | ✅ Pass | **Yes** — identical to base at defaults, and `sv_maxplayers` resizes a running server live. Must use the **`oldlinux`** build; the plain one fails on glibc and leaves a server with no slot support |
| [S6](S6.md) | What must the fifth player actually do to join? | Defines the big-coop ritual | **two players** | ⬜ Not started | — |
| [S7](S7.md) | What does the modded image weigh, and how much ephemeral storage does it need? | ~~gates the CDK change~~ | docker | ✅ Pass | **~10.4 GB, not 15.6** — `docker images` reports 50% high. Fargate's default leaves **10 GiB headroom**, so `ephemeralStorage` is **not a blocker**. Mods add 221 MB |
| [S8](S8.md) | Does ECR duplicate the base layers across repositories? | No — informs branch-vs-knob | AWS read | ✅ Pass | **Yes today** — `BLOB_MOUNTING` is DISABLED, so 1.30 GB is duplicated. **But the whole registry costs ~19c/month**, so cost is not an argument either way. One setting fixes it |

Status key: ⬜ Not started · 🟡 In progress · ✅ Pass · ❌ Fail · ⚠️ Partial

## Where this stands

**Six of eight are done (✅ 2026-08-28).** Everything answerable without a game
client is answered.

**S4 and S6 are all that remain, and both need a human with L4D2 open.** S4 is the
one that still shapes the design — it decides whether custom campaigns are a
setting on the main server or a server of their own, and the sources contradict
each other, so it cannot be closed by reading. S6 is smaller and may dissolve
itself: S5 proved the server side of big-coop works from a single cvar, and if
lobby reservation is the real obstacle then `sm_l4dd_unreserve` may remove the
client-side step entirely — which would collapse big-coop from a branch into a
knob.

Both spike images are built locally, so S4 needs no rebuild to start. Recipes are
`lab/s1-modded-image/` and `lab/s5-slot-machinery/`; `lab/srcds-rcon.py` is the
Source rcon client they use.

**Three of the six overturned something they were built on**, which is the whole
argument for running spikes rather than reasoning from the research:

- **S7** — the image is 10.4 GB, not the 15.6 GB `docker images` reports. That
  removed the ephemeral-storage blocker entirely.
- **S8** — registry duplication is real, and costs about 19 cents a month. That
  retired the cost argument for preferring knobs over branches.
- **S2** — 12 commands, not 13, and five of them need a client present, on a
  server that is empty most of its life.

**The original order, for reference.** S1 first, because everything except S8
needed a modded server to exist and S1 was what found out whether the base
template was real at all. Then the cheap server-side ones (S2, S3, S5, S7) in any
order on the same container, with S8 runnable at any time since it depended on
nothing.

## Where the pass bars live

Blueline keeps its method and pass criteria in a central kickoff document and
forbids restating them in the spike, so there is exactly one copy to keep true.
**These do not**, deliberately: respawn has no equivalent central spec, and
inventing one to hold eight pass bars would be indirection with nothing on the
other end. Each spike carries its own bar. If that stops being true — if a
standing L4D2 design document appears — move them and leave a pointer.

## Almost all of this is free

Seven of the eight run against a **local `docker run`**, not a deployed service.
That is deliberate: it matches how the GoldSrc work was verified, it keeps the
answers reproducible, and it costs nothing while every server sits scaled to
zero. Only S4 and S6 need a real client, and S8 is a read-only AWS query.

## The rule that makes this work

**A spike that hits a blocker spawns a spike.** Do not widen a spike to swallow
the new question — record the blocker, open a new file, and let the ledger show
that the question arose from evidence rather than from planning.

**A failed spike is a successful outcome.** The point is to close a direction
before it costs a rebuild. S4 exists precisely because two sources disagree, and
either answer is useful.

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
