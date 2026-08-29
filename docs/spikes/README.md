# L4D2 — Spike records

One file per spike. Each records **what was actually run and what it decided**.

These exist because the L4D2 research produced a set of questions that could not
be answered by reading, and a plan that rests on several assumptions nobody has
executed. A spike closes exactly one of those, with evidence.

| Spike | Question | Blocking | Needs | Status | Answer |
|---|---|---|---|---|---|
| [S1](S1.md) | Does the full mod stack build and load together? | **Yes — first** | docker | ✅ Pass | **Yes.** MetaMod 2.0.0 + SourceMod 1.12 + Left4DHooks 1.168 + All4Dead2 + Stripper all load, zero errors, **+0.3 GB**. Two files ship broken for this game and must be removed. Entrypoint puts the rcon password in **argv** |
| [S2](S2.md) | Can the MCP drive Source rcon, and do All4Dead2's commands work over it? | **Yes** | docker + rcon | ⬜ Not started | — |
| [S3](S3.md) | Does srcds log the rcon password the way HLDS does — **and is it in argv?** | Gates go-live | docker + rcon | ⬜ Not started | *(widened by S1)* |
| [S4](S4.md) | Do joining players need the custom campaign installed? | **Yes — decides the campaigns branch** | **a real client** | ⬜ Not started | — |
| [S5](S5.md) | Is the slot machinery inert at four players? | Decides base membership | docker | ⬜ Not started | — |
| [S6](S6.md) | What must the fifth player actually do to join? | Defines the big-coop ritual | **two players** | ⬜ Not started | — |
| [S7](S7.md) | What does the modded image weigh, and how much ephemeral storage does it need? | **Yes — gates the CDK change** | docker | ⬜ Not started | — |
| [S8](S8.md) | Does ECR duplicate the base layers across repositories? | No — informs branch-vs-knob | AWS read | ⬜ Not started | — |

Status key: ⬜ Not started · 🟡 In progress · ✅ Pass · ❌ Fail · ⚠️ Partial

## Order

**S1 is done (✅ 2026-08-28)** and unblocked S2, S3, S5 and S7. The build recipe
is `lab/s1-modded-image/`; `lab/srcds-rcon.py` is the client the remaining
server-side spikes use.

**S1 first.** Every spike except S8 needs a modded server to exist, and S1 is the
one that finds out whether the base template is even real.

After that the cheap server-side ones (S2, S3, S5, S7) can run in any order on
the same local container. **S4 and S6 need a human with the game open**, so they
are the ones to batch into a single sitting rather than pick up individually.

**S8 needs nothing and can run today** — it is the only spike that does not
depend on S1, and it settles a cost argument the proposed structure currently
leans on without evidence.

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
