//
// respawn_director — hold repair, as a real script file.
//
// WHY THIS IS A FILE AND NOT A STRING
// The first four attempts pushed this logic through L4D2_ExecVScriptCode as an escaped
// SourcePawn string literal. That path has an undocumented size ceiling — a 126-byte
// block defined fine while 350 and 425-byte blocks were REJECTED SILENTLY, with the
// plugin's own "is it defined" check the only thing that noticed. Ruled out along the
// way: the ~1006 char figure in left4dhooks.inc (835 failed), quoted literals (they
// survive), `\` line continuations (single-line failed too), and ternary spacing.
//
// A .nut loaded with DoIncludeScript has no size limit, no escaping, and is readable
// Squirrel in the repository rather than a mangled one-liner. Everything below used to
// be a string; none of it changed meaning in the move.
//
// THE BUG THIS REPAIRS
// L4B's `wait` does not steer a bot to a spot and hold it there. It walks the bot there
// once and then FREEZES it — BotReset(), movetype 0, velocity zeroed, Waiting latched —
// and nothing re-evaluates the position afterwards. A bot moved by anything that does
// not tell L4B stays put at the wrong place with the order still nominally in force.
//
// Two DIFFERENT broken holds were measured, which is why this does not key on `Waiting`:
//
//   live 2026-08-31  three bots ordered to hold, player walked ~1700 units. Bots ended
//                    up beside the player: Waiting=true, movetype=0, Paused=0, DestPos
//                    1727 away, stationary for minutes.
//   synthetic        the order's DestPos moved out from under a parked bot. She
//                    unlatched, walked partway and STALLED 192 units out, Waiting=false.
//
// A detector keyed on the latch catches the first and misses the second. The property
// both share is simply NOT GETTING CLOSER — and it does not depend on guessing which
// internal flag a future L4B leaves set.
//

// Per-bot memory, keyed by userid. Lives here beside the bots it describes.
if (!("RD_Last"  in getroottable())) ::RD_Last  <- {};
if (!("RD_Tries" in getroottable())) ::RD_Tries <- {};

// How many times one order may be re-issued before it is abandoned. Three, because a
// reachable point is reached on the first retry; more than that means the destination
// cannot be pathed to and retrying is just a log flood.
::RD_MAX_TRIES <- 3;

// Progress smaller than this counts as none. A bot shuffling on the spot is stuck.
::RD_MIN_PROGRESS <- 8.0;

/**
 * Is this bot failing to reach a wait order it holds?
 * Returns 1 when stuck, 0 otherwise. Clears the bookkeeping when it is fine.
 */
::RD_Chk <- function (id, b)
{
    local sc = b.GetScriptScope();
    local o  = sc.CurrentOrder;

    if (!o || o.OrderType != "wait" || !o.DestPos)
    {
        ::RD_Last[id] <- null;
        return 0;
    }

    local d = (b.GetOrigin() - o.DestPos).Length();
    if (d <= o.DestRadius)
    {
        // Arrived. Forget any accumulated retries — the next displacement starts fresh.
        ::RD_Last[id]  <- null;
        ::RD_Tries[id] <- 0;
        return 0;
    }

    local prev = (id in ::RD_Last) ? ::RD_Last[id] : null;
    ::RD_Last[id] <- d;

    // First sighting is never a diagnosis: one reading cannot show a trend, and a bot
    // legitimately walking to a distant point would otherwise be "repaired" mid-stride.
    if (prev == null || d < prev - ::RD_MIN_PROGRESS)
        return 0;

    return 1;
}

/**
 * Re-issue the identical order, or give up on it.
 * Returns 1 when re-issued, 100 when abandoned.
 */
::RD_Fix <- function (id, b)
{
    local sc = b.GetScriptScope();
    local o  = sc.CurrentOrder;

    local tries = (id in ::RD_Tries) ? ::RD_Tries[id] : 0;
    if (tries >= ::RD_MAX_TRIES)
    {
        // An unreachable hold is a decision for whoever placed it, not something to
        // retry silently for ever. Drop it and let the caller say so.
        sc.BotCancelOrders();
        ::RD_Tries[id] <- 0;
        ::RD_Last[id]  <- null;
        return 100;
    }
    ::RD_Tries[id] <- tries + 1;

    // Capture before cancelling — BotCancelOrders clears CurrentOrder.
    local p = o.DestPos;
    local l = o.DestLookAtPos;
    local h = o.HoldTime;
    local c = o.CanPause;

    // BotMoveReset is L4B's own un-latch: clears Waiting, restores movetype, drops the
    // forced crouch. Poking those netprops by hand would go stale the moment L4B changes.
    sc.BotMoveReset();
    sc.BotCancelOrders();
    ::Left4Bots.BotOrderAdd(b, "wait", null, null, p, l, h, c);

    // Start the progress trend over, so the retry is judged on its own movement.
    ::RD_Last[id] <- null;
    return 1;
}

/** Sweep every handled bot. Repairs count as units, abandonments as hundreds. */
::RD_RepairHolds <- function ()
{
    local n = 0;
    foreach (id, b in ::Left4Bots.Bots)
    {
        if (::RD_Chk(id, b) > 0)
            n += ::RD_Fix(id, b);
    }
    return n;
}
