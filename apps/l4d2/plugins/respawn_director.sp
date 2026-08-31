/**
 * respawn_director — the agent's bridge into Left 4 Bots 2.
 *
 * WHY THIS EXISTS
 * ---------------
 * L4B2's command handler bails on its very first line when there is no player:
 *
 *     ::Left4Bots.HandleCommand <- function (player, cmd, args, text)
 *     {
 *       if (!player || !player.IsValid() || IsPlayerABot(player) || ...) return;
 *
 * rcon executes as Console<0>, which is not a player entity, so the agent cannot issue
 * orders through the chat-command path no matter what permissions it holds. That is
 * structural, not a configuration problem (measured — see docs/spikes/S10.md).
 *
 * v2 worked around it by impersonating a connected human with FakeClientCommand. That
 * cost two things, and both were defects rather than trade-offs:
 *
 *   - L4B checked THAT PLAYER'S level, so every server needed an
 *     `ems/left4lib/cfg/admins.txt` provisioned with the right Steam IDs, and a server
 *     missing it dropped every order SILENTLY.
 *   - a position order inherited the impersonated player's LIVE crosshair, so a
 *     "wait there" captured seconds ago landed wherever they happened to be looking
 *     when the agent got around to sending it.
 *
 * v3 calls L4B's order API directly instead:
 *
 *     L4D2_GetVScriptOutput("... ::Left4Bots.BotOrderAdd(bot, type, from, destEnt,
 *                                destPos, destLookAtPos, hold, canPause) ...")
 *
 * The permission check lives in `HandleCommand`, not in `BotOrderAdd`, so this path
 * needs no admin file at all — and `destPos` takes a literal vector, so the destination
 * is the point the plugin captured at message time. Measured end to end in S12: a bot
 * obeyed an order carrying literal coordinates with NO human connected and no admins
 * file present.
 *
 * THREE THINGS S12 MEASURED THAT THIS FILE DEPENDS ON
 * --------------------------------------------------
 *   1. `L4D2_GetVScriptOutput` returns the value through a convar, and an integer 0
 *      comes back indistinguishable from "the call failed". BotOrderAdd returns 0 on
 *      its MOST COMMON SUCCESS PATH (the order replaced CurrentOrder), so every value
 *      crossing the boundary is `.tostring()`d. This is correctness, not style.
 *   2. Indexing `::Left4Bots.Bots` with an absent userid THROWS inside the VM rather
 *      than returning null, and a throw is not reportable through the native's bool.
 *      Every call therefore guards with `in` first and returns a sentinel.
 *   3. The order vocabulary is closed (L4B's own OrderPriorities table). Anything else
 *      returns -1, so it is validated here and named in the error.
 *
 * The chat-command path is deliberately NOT kept as a fallback. It is the one that
 * fails silently when admins.txt is missing, and a footgun that works most of the time
 * is worse than one that is absent.
 *
 * It is also two-way. The agent cannot watch chat (server log echo proved unreliable —
 * it died mid-session during S10 and took four readings with it), so this plugin owns
 * an inbox the agent drains over rcon. Nothing outside this plugin can break it.
 *
 * COMMANDS (all ADMFLAG_ROOT; rcon satisfies that as Console<0> — see S2)
 *   sm_rd_inbox            drain pending player messages, one per line
 *   sm_rd_order <target> <type> [at=x,y,z] [look=x,y,z] [ent=N] [hold=S] [pause=0|1] [queue=1]
 *   sm_rd_cancel <target> [type]   drop queued orders
 *   sm_rd_orders <target>          read back each bot's queue
 *   sm_rd_status           bots, humans, and whether the L4B order API is reachable
 *   (a `wait` order is also repaired automatically — see HOLD REPAIR below)
 *   sm_rd_scene            tactical readout
 *   sm_rd_give <ent> [who] grant an item (operator-gated)
 */

#include <sourcemod>
#include <sdktools>
#include <left4dhooks>

#pragma semicolon 1
#pragma newdecls required

#define PLUGIN_VERSION "0.4.0"
#define INBOX_MAX      64
#define MSG_MAXLEN     192

public Plugin myinfo =
{
    name        = "respawn_director",
    author      = "respawn",
    description = "Agent bridge for Left 4 Bots 2: VScript order injection + a chat inbox",
    version     = PLUGIN_VERSION,
    url         = "https://github.com/"
};

/* Ring buffer of captured messages. A ring rather than a growing list because the
   agent may not drain for a long time, and dropping the OLDEST message is the right
   loss when a player is spamming — the newest intent is the one still relevant. */
ArrayList g_Inbox;

/* Messages addressed to the bots start with this. Filtering server-side keeps
   ordinary table talk out of the agent's context; widening it later is one strcmp. */
ConVar g_cvPrefix;
ConVar g_cvEnabled;

/* Item granting is a CHEAT, and the operator owns that decision — not a player, and
   not the agent. A player can ask; the agent might misread intent or simply be
   agreeable. Neither is a control. Enforced here so the answer is no even when
   everything upstream says yes. Default off, opt in deliberately. */
ConVar g_cvAllowGive;

/* See HOLD REPAIR. Default on, because the failure it fixes is silent and the repair
   costs one VM call every few seconds. */
ConVar g_cvHoldRepair;

public void OnPluginStart()
{
    g_Inbox = new ArrayList(ByteCountToCells(MSG_MAXLEN));

    g_cvEnabled = CreateConVar("rd_enabled", "1",
        "Capture bot-directed chat into the agent inbox.", _, true, 0.0, true, 1.0);
    g_cvPrefix = CreateConVar("rd_prefix", "@",
        "Chat prefix that marks a message as addressed to the bots.");
    g_cvAllowGive = CreateConVar("rd_allow_give", "0",
        "Allow the agent to grant weapons/items (a cheat). Operator decision; off by default.",
        _, true, 0.0, true, 1.0);
    g_cvHoldRepair = CreateConVar("rd_hold_repair", "1",
        "Re-issue a wait order when the bot has been displaced from it (see HOLD REPAIR).",
        _, true, 0.0, true, 1.0);

    CreateTimer(3.0, Timer_RepairHolds, _, TIMER_REPEAT | TIMER_FLAG_NO_MAPCHANGE);

    RegAdminCmd("sm_rd_inbox",  Cmd_Inbox,  ADMFLAG_ROOT, "Drain pending player messages");
    RegAdminCmd("sm_rd_order",  Cmd_Order,  ADMFLAG_ROOT, "Issue an L4B order: sm_rd_order <target> <type> [at=x,y,z] [look=x,y,z] [ent=N] [hold=S] [pause=0|1]");
    RegAdminCmd("sm_rd_cancel", Cmd_Cancel, ADMFLAG_ROOT, "Drop queued L4B orders: sm_rd_cancel <target> [type]");
    RegAdminCmd("sm_rd_orders", Cmd_Orders, ADMFLAG_ROOT, "Read back each bot's order queue");
    RegAdminCmd("sm_rd_status", Cmd_Status, ADMFLAG_ROOT, "Report bots, humans and order readiness");
    RegAdminCmd("sm_rd_scene",  Cmd_Scene,  ADMFLAG_ROOT, "Tactical readout: survivors, threats, the Director's own intensity");
    RegAdminCmd("sm_rd_give",   Cmd_Give,   ADMFLAG_ROOT, "Give a weapon/item: sm_rd_give <entity_name> [player]");

    AddCommandListener(OnSay, "say");
    AddCommandListener(OnSay, "say_team");

    AutoExecConfig(true, "respawn_director");
}

/* ---------- addressing + aim capture --------------------------------------- */

/** World point the client is looking at; falls back to eye position on a miss. */
static void GetAimPoint(int client, float out[3])
{
    float eye[3], ang[3];
    GetClientEyePosition(client, eye);
    GetClientEyeAngles(client, ang);
    Handle tr = TR_TraceRayFilterEx(eye, ang, MASK_SOLID, RayType_Infinite, TraceIgnorePlayers, client);
    if (TR_DidHit(tr)) TR_GetEndPosition(out, tr);
    else               out = eye;
    delete tr;
}

public bool TraceIgnorePlayers(int entity, int mask, any data)
{
    return entity != data && (entity < 1 || entity > MaxClients);
}

/** Nearest living survivor bot to `client`, or 0. */
static int ClosestBot(int client)
{
    float me[3]; GetClientAbsOrigin(client, me);
    int best = 0; float bestd = 999999.0;
    for (int i = 1; i <= MaxClients; i++)
    {
        if (i == client || !IsClientInGame(i) || !IsFakeClient(i)) continue;
        if (GetClientTeam(i) != 2 || !IsPlayerAlive(i)) continue;
        float p[3]; GetClientAbsOrigin(i, p);
        float d = GetVectorDistance(me, p);
        if (d < bestd) { bestd = d; best = i; }
    }
    return best;
}

/**
 * Pull the leading @tag off a message and resolve it to a botsource L4B understands.
 *   @team / @all / @bots  -> "bots"
 *   @closest / @me        -> the nearest bot, by name
 *   @<botname>            -> that bot
 * No tag is not an error — it means "unaddressed", and the agent decides.
 */
static void SplitTag(int client, char[] body, char[] tag, int tagLen, char[] resolved, int resLen)
{
    strcopy(tag, tagLen, "");
    strcopy(resolved, resLen, "");

    if (body[0] != '@')
        return;

    int sp = FindCharInString(body, ' ');
    char raw[32];
    strcopy(raw, sizeof(raw), body);
    if (sp > 0) raw[sp] = '\0';
    strcopy(tag, tagLen, raw);

    /* Strip the tag from the body so the agent reads intent, not addressing. */
    if (sp > 0) { char rest[MSG_MAXLEN]; strcopy(rest, sizeof(rest), body[sp + 1]); TrimString(rest); strcopy(body, MSG_MAXLEN, rest); }
    else body[0] = '\0';

    char t[32];
    strcopy(t, sizeof(t), raw[1]);   /* drop the '@' */

    if (StrEqual(t, "team", false) || StrEqual(t, "all", false) || StrEqual(t, "bots", false))
    {
        strcopy(resolved, resLen, "bots");
        return;
    }
    if (StrEqual(t, "closest", false) || StrEqual(t, "nearest", false) || StrEqual(t, "me", false))
    {
        int b = ClosestBot(client);
        if (b > 0) GetClientName(b, resolved, resLen);
        else       strcopy(resolved, resLen, "none");
        return;
    }
    /* Addressed to the agent itself, not to any bot — "give me X", "what is ahead",
       "turn up the heat". Vendor-neutral on purpose: the tag outlives whichever model
       is behind it. */
    if (StrEqual(t, "agent", false) || StrEqual(t, "claude", false) || StrEqual(t, "bot", false))
    {
        strcopy(resolved, resLen, "agent");
        return;
    }

    /* Otherwise it SHOULD name a bot — but only say so if it actually does. Assuming
       it did meant an unrecognised tag arrived looking like a valid target, which is
       the same class of bug as swallowing the tag marker: guessing where the honest
       answer is "unknown". */
    for (int i = 1; i <= MaxClients; i++)
    {
        if (!IsClientInGame(i) || !IsFakeClient(i) || GetClientTeam(i) != 2) continue;
        char n[MAX_NAME_LENGTH]; GetClientName(i, n, sizeof(n));
        if (StrEqual(n, t, false)) { strcopy(resolved, resLen, n); return; }
    }
    strcopy(resolved, resLen, "?");
}

/* ---------- inbox ---------------------------------------------------------- */

public Action OnSay(int client, const char[] command, int argc)
{
    if (!g_cvEnabled.BoolValue || client <= 0 || !IsClientInGame(client) || IsFakeClient(client))
        return Plugin_Continue;

    char text[MSG_MAXLEN];
    GetCmdArgString(text, sizeof(text));
    StripQuotes(text);
    TrimString(text);

    char prefix[8];
    g_cvPrefix.GetString(prefix, sizeof(prefix));
    if (prefix[0] != '\0' && strncmp(text, prefix, strlen(prefix)) != 0)
        return Plugin_Continue;

    /* Resolve the addressing tag SERVER-SIDE. @closest cannot be resolved by the
       agent — it depends on positions at the moment of speaking, and by the time the
       agent reads the message the nearest bot may have moved. Resolving here freezes
       the intent, the same reason positions are captured at message time. */
    /* Keep the prefix on for tag parsing. '@' means BOTH "this is addressed to the
       bots" and "here is which bot" — stripping it as a capture marker destroyed the
       addressing, so `@coach cover me` arrived with an empty tag. Parse first, strip
       inside SplitTag. */
    char body[MSG_MAXLEN];
    strcopy(body, sizeof(body), text);
    TrimString(body);
    if (body[0] == '\0')
        return Plugin_Continue;

    char name[MAX_NAME_LENGTH], steamid[32], line[MSG_MAXLEN];
    GetClientName(client, name, sizeof(name));
    if (!GetClientAuthId(client, AuthId_Steam2, steamid, sizeof(steamid)))
        strcopy(steamid, sizeof(steamid), "UNKNOWN");

    char tag[32], resolved[64];
    SplitTag(client, body, tag, sizeof(tag), resolved, sizeof(resolved));

    /* Position and aim frozen HERE, not at order time. This is the whole reason the
       plugin captures rather than the agent asking later: by then you have moved and
       looked elsewhere, and "cover the staircase" lands on empty floor. */
    float eye[3], aim[3];
    GetClientEyePosition(client, eye);
    GetAimPoint(client, aim);

    /* Pipe-delimited so the agent parses it without guessing at whitespace.
       userid (not client index) because indices are reused within a round. */
    Format(line, sizeof(line),
        "MSG|%d|%s|%s|tag=%s|to=%s|at=%.0f %.0f %.0f|aim=%.0f %.0f %.0f|%s",
        GetClientUserId(client), name, steamid, tag, resolved,
        eye[0], eye[1], eye[2], aim[0], aim[1], aim[2], body);

    if (g_Inbox.Length >= INBOX_MAX)
        g_Inbox.Erase(0);
    g_Inbox.PushString(line);

    return Plugin_Continue;   /* never swallow the message — other players still see it */
}

public Action Cmd_Inbox(int client, int args)
{
    int n = g_Inbox.Length;
    if (n == 0)
    {
        ReplyToCommand(client, "INBOX|0");
        return Plugin_Handled;
    }

    ReplyToCommand(client, "INBOX|%d", n);
    char line[MSG_MAXLEN];
    for (int i = 0; i < n; i++)
    {
        g_Inbox.GetString(i, line, sizeof(line));
        ReplyToCommand(client, "%s", line);
    }
    g_Inbox.Clear();   /* drained: at-most-once delivery, deliberately */
    return Plugin_Handled;
}

/* ---------- order injection ------------------------------------------------ */

/**
 * L4B's order vocabulary, read out of its own OrderPriorities table. Closed set:
 * BotOrderAdd returns -1 for anything else, and -1 is also what an invalid bot
 * returns — so validating here is the only way the caller learns WHICH of the two
 * went wrong. The list is duplicated from the VPK rather than queried because
 * querying it costs a VM round trip per order to re-learn something that only
 * changes when L4B is upgraded, which is a pinned event.
 */
static const char ORDER_TYPES[][] =
{
    "carry", "follow", "lead", "scavenge", "goto", "wait",
    "deploy", "tempheal", "heal", "use", "destroy", "witch"
};

static bool IsOrderType(const char[] t)
{
    for (int i = 0; i < sizeof(ORDER_TYPES); i++)
        if (StrEqual(ORDER_TYPES[i], t, false))
            return true;
    return false;
}

static void OrderTypeList(char[] out, int maxlen)
{
    out[0] = '\0';
    for (int i = 0; i < sizeof(ORDER_TYPES); i++)
    {
        if (i > 0) StrCat(out, maxlen, " ");
        StrCat(out, maxlen, ORDER_TYPES[i]);
    }
}

/**
 * Run one expression in the VScript VM and hand back what it evaluated to.
 *
 * Two rules, both measured in S12 and both invisible from the native's signature:
 *   - the caller must have already appended `.tostring()`, because an integer 0
 *     crosses the boundary as an empty string and reads as failure;
 *   - a false return can mean the code threw, so it is reported as such rather than
 *     folded into "no".
 */
static bool VsEval(const char[] expr, char[] out, int maxlen)
{
    char code[1024];
    Format(code, sizeof(code), "<RETURN>%s</RETURN>", expr);
    return L4D2_GetVScriptOutput(code, out, maxlen);
}

/** Is Left4Bots loaded and running a mode? Everything below is worthless if not. */
static bool L4BReady()
{
    char out[64];
    if (!VsEval("((\"Left4Bots\" in getroottable()) ? ::Left4Bots.ModeStarted : false).tostring()", out, sizeof(out)))
        return false;
    return StrEqual(out, "true");
}

/**
 * Resolve a target token to survivor-bot client indices.
 *   all | bots | team          every L4B-handled bot
 *   #<userid>                  exactly that one
 *   <name>                     case-insensitive substring, first match
 * Returns the count written into `out`.
 */
static int ResolveTargets(const char[] target, int[] out, int maxout)
{
    int n = 0;
    bool all = StrEqual(target, "all", false) || StrEqual(target, "bots", false)
            || StrEqual(target, "team", false);

    int wantUserId = -1;
    if (target[0] == '#')
        wantUserId = StringToInt(target[1]);

    for (int i = 1; i <= MaxClients && n < maxout; i++)
    {
        if (!IsClientInGame(i) || !IsFakeClient(i) || GetClientTeam(i) != 2 || !IsPlayerAlive(i))
            continue;
        if (all)
        {
            out[n++] = i;
            continue;
        }
        if (wantUserId >= 0)
        {
            if (GetClientUserId(i) == wantUserId) { out[n++] = i; break; }
            continue;
        }
        char nm[MAX_NAME_LENGTH];
        GetClientName(i, nm, sizeof(nm));
        /* Collect EVERY name match rather than taking the first. Survivor names are not
           unique: a bot spawned to replace a lost one arrives as a duplicate of an
           existing survivor (measured 2026-08-31 — the game itself then reports
           "Ellis saved Ellis"), and with two Ellises `sm_rd_order Ellis` matched one,
           reported OK and of=1, and gave no hint the other existed. The caller decides
           what to do about the ambiguity; this function must not decide for them. */
        if (StrContains(nm, target, false) != -1) out[n++] = i;
    }
    return n;
}

/** Do two or more living survivor bots answer to this name? */
static bool IsAmbiguousName(const char[] target)
{
    if (StrEqual(target, "all", false) || StrEqual(target, "bots", false)
        || StrEqual(target, "team", false) || target[0] == '#')
        return false;
    int bots[MAXPLAYERS + 1];
    return ResolveTargets(target, bots, sizeof(bots)) > 1;
}

/** Names of every living survivor bot matching `target`, with userids, for an error. */
static void DescribeMatches(const char[] target, char[] out, int maxlen)
{
    out[0] = '\0';
    int bots[MAXPLAYERS + 1];
    int n = ResolveTargets(target, bots, sizeof(bots));
    for (int i = 0; i < n; i++)
    {
        char nm[MAX_NAME_LENGTH], one[80];
        GetClientName(bots[i], nm, sizeof(nm));
        Format(one, sizeof(one), "%s#%d(%s)", (i > 0) ? " " : "", GetClientUserId(bots[i]), nm);
        StrCat(out, maxlen, one);
    }
}

/** Parse "x,y,z" (or "x y z") into a vector. False when it is not three numbers. */
static bool ParseVector(const char[] src, float out[3])
{
    char work[96];
    strcopy(work, sizeof(work), src);
    ReplaceString(work, sizeof(work), ",", " ");
    char parts[4][24];
    if (ExplodeString(work, " ", parts, sizeof(parts), sizeof(parts[])) < 3)
        return false;
    for (int i = 0; i < 3; i++)
    {
        TrimString(parts[i]);
        if (parts[i][0] == '\0')
            return false;
        out[i] = StringToFloat(parts[i]);
    }
    return true;
}

/**
 * sm_rd_order <target> <type> [at=x,y,z] [look=x,y,z] [ent=N] [hold=S] [pause=0|1]
 *
 * key=value rather than positional because the arguments a given order type uses are
 * disjoint — `wait` wants a position, `use` wants an entity, `follow` wants neither —
 * and a positional form would need placeholder nulls that are easy to miscount and
 * impossible to read back in a log.
 */
public Action Cmd_Order(int client, int args)
{
    if (args < 2)
    {
        char types[160];
        OrderTypeList(types, sizeof(types));
        ReplyToCommand(client, "ERR|usage|sm_rd_order <all|#userid|name> <type> [at=x,y,z] [look=x,y,z] [ent=N] [hold=S] [pause=0|1] [queue=1]");
        ReplyToCommand(client, "ERR|types|%s", types);
        return Plugin_Handled;
    }

    char target[64], type[32];
    GetCmdArg(1, target, sizeof(target));
    GetCmdArg(2, type, sizeof(type));

    if (!IsOrderType(type))
    {
        char types[160];
        OrderTypeList(types, sizeof(types));
        /* Name the vocabulary. BotOrderAdd answers -1 for a bad type AND for a bad
           bot, so an unnamed rejection sends the caller looking in the wrong place. */
        ReplyToCommand(client, "ERR|bad_type|%s|known: %s", type, types);
        return Plugin_Handled;
    }

    /* Defaults chosen so an order with no keys is still a legal L4B order. */
    char destPos[64]  = "null";
    char destLook[64] = "null";
    char destEnt[48]  = "null";
    float hold = 0.0;
    bool canPause = true;

    /* SUPERSEDE BY DEFAULT, and this is the important one.
       L4B orders its queue by a fixed priority table (follow/lead/carry/scavenge = 0,
       goto/wait = 1, use/heal/deploy/destroy = 2, witch = 3) and BotOrderAdd will not
       replace a CurrentOrder whose priority is >= the new one — it inserts the new order
       BEHIND it and returns a queue position.

       Measured live 2026-08-31: bots running `goto` (1) were sent `follow` (0) for
       "regroup on me". The call answered OK and the bots kept walking away. A success
       reply for an order that does nothing is the exact failure shape this project keeps
       finding, and it would require every caller to know L4B's priority table to avoid.

       An agent-issued order almost always expresses a NEW intent that REPLACES the old
       one — the player said "actually, come here" — so cancelling first is the honest
       default. `queue=1` opts into L4B's own priority behaviour for the rare case that
       genuinely wants to append. */
    bool supersede = true;

    for (int a = 3; a <= args; a++)
    {
        char kv[96];
        GetCmdArg(a, kv, sizeof(kv));
        int eq = FindCharInString(kv, '=');
        if (eq <= 0)
        {
            ReplyToCommand(client, "ERR|bad_arg|%s|expected key=value", kv);
            return Plugin_Handled;
        }
        char key[16];
        strcopy(key, sizeof(key), kv);
        key[eq] = '\0';
        char val[80];
        strcopy(val, sizeof(val), kv[eq + 1]);

        if (StrEqual(key, "at", false) || StrEqual(key, "look", false))
        {
            float v[3];
            if (!ParseVector(val, v))
            {
                ReplyToCommand(client, "ERR|bad_vector|%s=%s|expected three numbers", key, val);
                return Plugin_Handled;
            }
            /* Squirrel literal. Six decimals because a nav position rounded to whole
               units can land inside geometry, and DestRadius is already the tolerance. */
            char lit[64];
            Format(lit, sizeof(lit), "Vector(%f,%f,%f)", v[0], v[1], v[2]);
            if (StrEqual(key, "at", false)) strcopy(destPos,  sizeof(destPos),  lit);
            else                            strcopy(destLook, sizeof(destLook), lit);
        }
        else if (StrEqual(key, "ent", false))
        {
            int e = StringToInt(val);
            if (e <= 0 || !IsValidEntity(e))
            {
                ReplyToCommand(client, "ERR|bad_entity|%s", val);
                return Plugin_Handled;
            }
            Format(destEnt, sizeof(destEnt), "EntIndexToHScript(%d)", e);
        }
        else if (StrEqual(key, "hold", false))  hold = StringToFloat(val);
        else if (StrEqual(key, "pause", false)) canPause = (StringToInt(val) != 0);
        else if (StrEqual(key, "queue", false)) supersede = (StringToInt(val) == 0);
        else
        {
            ReplyToCommand(client, "ERR|unknown_key|%s|known: at look ent hold pause queue", key);
            return Plugin_Handled;
        }
    }

    if (!L4BReady())
    {
        /* Distinguish the two reasons the API is unreachable. "Not loaded" is a build
           problem; "mode not started" is a server that has not begun a round, which
           resolves by itself and must not be reported as a fault. */
        ReplyToCommand(client, "ERR|l4b_unready|Left4Bots is absent or no mode has started; no order can be placed");
        return Plugin_Handled;
    }

    if (IsAmbiguousName(target))
    {
        /* Refuse rather than pick. Addressing the wrong bot is not visibly different
           from addressing the right one, so a guess here is unrecoverable. */
        char who[256];
        DescribeMatches(target, who, sizeof(who));
        ReplyToCommand(client, "ERR|ambiguous|%s|matches: %s|address one with #userid, or use all", target, who);
        return Plugin_Handled;
    }

    int bots[MAXPLAYERS + 1];
    int n = ResolveTargets(target, bots, sizeof(bots));
    if (n == 0)
    {
        ReplyToCommand(client, "ERR|no_target|%s|no living survivor bot matches", target);
        return Plugin_Handled;
    }

    int placed = 0, queued = 0;
    for (int i = 0; i < n; i++)
    {
        int uid = GetClientUserId(bots[i]);
        char nm[MAX_NAME_LENGTH];
        GetClientName(bots[i], nm, sizeof(nm));

        /* The `in` guard is load-bearing: indexing Bots with an absent userid THROWS
           inside the VM, and a throw surfaces only as a false return with no message.
           -2 means "connected survivor bot that L4B is not handling", which is a real
           and different state from -1. */
        /* Cancel and add in ONE expression rather than two calls: a cancel that lands and
           an add that does not would leave the bot with no order at all, which is worse
           than either outcome on its own. Squirrel's comma operator keeps them atomic
           from the VM's point of view. */
        char clear[96];
        if (supersede)
            Format(clear, sizeof(clear), "::Left4Bots.Bots[%d].GetScriptScope().BotCancelOrders(), ", uid);
        else
            clear[0] = '\0';

        char expr[640], out[64];
        Format(expr, sizeof(expr),
            "((%d in ::Left4Bots.Bots) ? (%s::Left4Bots.BotOrderAdd(::Left4Bots.Bots[%d], \"%s\", null, %s, %s, %s, %f, %s)) : -2).tostring()",
            uid, clear, uid, type, destEnt, destPos, destLook, hold, canPause ? "true" : "false");

        if (!VsEval(expr, out, sizeof(out)))
        {
            ReplyToCommand(client, "ERR|vm_error|bot=%s|userid=%d|the VScript call threw or returned nothing", nm, uid);
            continue;
        }
        int rc = StringToInt(out);
        if (rc == -2)
            ReplyToCommand(client, "ERR|not_handled|bot=%s|userid=%d|L4B is not managing this bot", nm, uid);
        else if (rc < 0)
            ReplyToCommand(client, "ERR|refused|bot=%s|userid=%d|type=%s|BotOrderAdd returned %d", nm, uid, type, rc);
        else if (rc == 0)
        {
            /* 0 means it replaced CurrentOrder — the bot acts on it NOW. */
            ReplyToCommand(client, "OK|order|bot=%s|userid=%d|type=%s|queue=0|active", nm, uid, type);
            placed++;
        }
        else
        {
            /* Anything above 0 means the bot is still doing something else and will get
               to this later — or never. Reported as QUEUED rather than OK, because with
               supersede off that is the state a caller most needs to notice and the one
               that looks identical to success. */
            ReplyToCommand(client, "QUEUED|bot=%s|userid=%d|type=%s|behind=%d|not acting on it yet", nm, uid, type, rc);
            queued++;
        }
    }

    ReplyToCommand(client, "ORDER|placed=%d|queued=%d|of=%d", placed, queued, n);
    return Plugin_Handled;
}

/**
 * sm_rd_cancel <target> [type]
 *
 * BotCancelOrders returns null, so there is nothing useful to read back from the call
 * itself — the order COUNT is reported instead, which is the fact the caller wanted.
 */
public Action Cmd_Cancel(int client, int args)
{
    if (args < 1)
    {
        ReplyToCommand(client, "ERR|usage|sm_rd_cancel <all|#userid|name> [type]");
        return Plugin_Handled;
    }

    char target[64], type[32];
    GetCmdArg(1, target, sizeof(target));
    if (args >= 2)
    {
        GetCmdArg(2, type, sizeof(type));
        if (!IsOrderType(type))
        {
            char types[160];
            OrderTypeList(types, sizeof(types));
            ReplyToCommand(client, "ERR|bad_type|%s|known: %s", type, types);
            return Plugin_Handled;
        }
    }
    else type[0] = '\0';

    if (!L4BReady())
    {
        ReplyToCommand(client, "ERR|l4b_unready|Left4Bots is absent or no mode has started");
        return Plugin_Handled;
    }

    if (IsAmbiguousName(target))
    {
        /* Refuse rather than pick. Addressing the wrong bot is not visibly different
           from addressing the right one, so a guess here is unrecoverable. */
        char who[256];
        DescribeMatches(target, who, sizeof(who));
        ReplyToCommand(client, "ERR|ambiguous|%s|matches: %s|address one with #userid, or use all", target, who);
        return Plugin_Handled;
    }

    int bots[MAXPLAYERS + 1];
    int n = ResolveTargets(target, bots, sizeof(bots));
    if (n == 0)
    {
        ReplyToCommand(client, "ERR|no_target|%s", target);
        return Plugin_Handled;
    }

    for (int i = 0; i < n; i++)
    {
        int uid = GetClientUserId(bots[i]);
        char nm[MAX_NAME_LENGTH];
        GetClientName(bots[i], nm, sizeof(nm));

        char arg[40];
        if (type[0] != '\0') Format(arg, sizeof(arg), "\"%s\"", type);
        else                 strcopy(arg, sizeof(arg), "");

        char expr[512], out[64];
        Format(expr, sizeof(expr),
            "((%d in ::Left4Bots.Bots) ? (::Left4Bots.Bots[%d].GetScriptScope().BotCancelOrders(%s), ::Left4Bots.BotOrdersCount(::Left4Bots.Bots[%d])) : -2).tostring()",
            uid, uid, arg, uid);

        if (!VsEval(expr, out, sizeof(out)))
            ReplyToCommand(client, "ERR|vm_error|bot=%s|userid=%d", nm, uid);
        else if (StringToInt(out) == -2)
            ReplyToCommand(client, "ERR|not_handled|bot=%s|userid=%d", nm, uid);
        else
            ReplyToCommand(client, "OK|cancelled|bot=%s|userid=%d|remaining=%s", nm, uid, out);
    }
    return Plugin_Handled;
}

/**
 * sm_rd_orders <target> — read each bot's queue back.
 *
 * This exists because an order that was accepted and an order that is being ACTED ON
 * are different facts, and only the second one matters. BotOrderAdd's return says the
 * order was queued; this says what the bot is doing about it.
 */
public Action Cmd_Orders(int client, int args)
{
    char target[64];
    if (args >= 1) GetCmdArg(1, target, sizeof(target));
    else           strcopy(target, sizeof(target), "all");

    if (!L4BReady())
    {
        ReplyToCommand(client, "ERR|l4b_unready|Left4Bots is absent or no mode has started");
        return Plugin_Handled;
    }

    int bots[MAXPLAYERS + 1];
    int n = ResolveTargets(target, bots, sizeof(bots));
    if (n == 0)
    {
        ReplyToCommand(client, "ERR|no_target|%s", target);
        return Plugin_Handled;
    }

    for (int i = 0; i < n; i++)
    {
        int uid = GetClientUserId(bots[i]);
        char nm[MAX_NAME_LENGTH];
        GetClientName(bots[i], nm, sizeof(nm));

        char expr[512], out[512];
        Format(expr, sizeof(expr),
            "((%d in ::Left4Bots.Bots) ? (::Left4Bots.BotOrdersCount(::Left4Bots.Bots[%d]) + \"|\" + ::Left4Bots.BotOrderToString(::Left4Bots.Bots[%d].GetScriptScope().CurrentOrder)) : \"-2|\").tostring()",
            uid, uid, uid);

        if (!VsEval(expr, out, sizeof(out)))
            ReplyToCommand(client, "ERR|vm_error|bot=%s|userid=%d", nm, uid);
        else
            ReplyToCommand(client, "ORDERS|bot=%s|userid=%d|%s", nm, uid, out);
    }
    return Plugin_Handled;
}

/** First connected human. `give` and `scene` are both anchored on a person. */
static int FindHuman()
{
    for (int i = 1; i <= MaxClients; i++)
        if (IsClientInGame(i) && !IsFakeClient(i))
            return i;
    return 0;
}

/* ---------- HOLD REPAIR ----------------------------------------------------- */

/**
 * L4B's `wait` does not steer a bot to a spot and keep it there. It walks the bot there
 * ONCE and then FREEZES it:
 *
 *     BotReset();
 *     NetProps.SetPropInt(self, "movetype", 0);
 *     self.SetVelocity(Vector(0, 0, 0));
 *     Waiting = true;                       // latched
 *
 * Nothing re-evaluates the position afterwards. So when the engine relocates a survivor
 * bot — which it does routinely to bots left behind by the humans — the bot arrives at
 * the new place and simply freezes again there, with the order still nominally pointing
 * at coordinates it will never walk back to.
 *
 * MEASURED LIVE 2026-08-31: three bots ordered to hold, player walked ~1700 units, bots
 * ended up beside the player reading `Waiting=true`, `movetype=0`, `Paused=0`, and
 * `OrderType: wait` with a DestPos 1727 units away. Stationary and never returning. To
 * the player that is "hold here" silently becoming "freeze wherever you end up", and it
 * is worse with `pause=0`, which removes the vanilla-AI handoff that would at least have
 * shaken them loose.
 *
 * The repair: `Waiting == true` AND outside DestRadius of the order's own DestPos is
 * unambiguous — a bot that walked there itself is inside the radius by construction, so
 * this combination can only mean it was moved by something that did not tell L4B. Undo
 * the latch with L4B's own BotMoveReset (it clears Waiting, restores movetype and drops
 * the forced crouch) and re-issue the identical order.
 *
 * Done entirely inside the VM so the check costs one call rather than one per bot, and
 * so a displaced bot cannot be seen and then not repaired across two round trips.
 */
static void DefineRepairFunc()
{
    L4D2_ExecVScriptCode(
        "::RD_RepairHolds <- function() { local n = 0; \
         foreach (id, b in ::Left4Bots.Bots) { \
           local s = b.GetScriptScope(); local o = s.CurrentOrder; \
           if (o && o.OrderType == \"wait\" && o.DestPos && s.Waiting \
               && (b.GetOrigin() - o.DestPos).Length() > o.DestRadius) { \
             local p = o.DestPos; local l = o.DestLookAtPos; \
             local h = o.HoldTime; local c = o.CanPause; \
             s.BotMoveReset(); s.BotCancelOrders(); \
             ::Left4Bots.BotOrderAdd(b, \"wait\", null, null, p, l, h, c); n++; } } \
         return n; }");
}

public void OnMapStart()
{
    /* The VM is rebuilt on every map change, so the function has to be redefined. Delayed
       because Left4Bots is not loaded at the instant the map starts and the definition
       references nothing until it runs — but a caller might. */
    CreateTimer(10.0, Timer_DefineRepair);
}

public Action Timer_DefineRepair(Handle timer)
{
    DefineRepairFunc();
    return Plugin_Stop;
}

public Action Timer_RepairHolds(Handle timer)
{
    if (!g_cvHoldRepair.BoolValue || !L4BReady())
        return Plugin_Continue;

    char out[64];
    /* Define-if-missing rather than trusting OnMapStart: a plugin reloaded mid-map has
       never run it, and a silent no-op repair is exactly the failure this exists to
       remove. */
    if (!VsEval("((\"RD_RepairHolds\" in getroottable()) ? 1 : 0).tostring()", out, sizeof(out))
        || StringToInt(out) != 1)
    {
        DefineRepairFunc();
        return Plugin_Continue;
    }

    if (!VsEval("(::RD_RepairHolds()).tostring()", out, sizeof(out)))
        return Plugin_Continue;

    int n = StringToInt(out);
    if (n > 0)
    {
        /* Say so. A repair nobody can see is indistinguishable from the bug not existing,
           and this one fires precisely when somebody is wondering why their bots moved. */
        LogMessage("[respawn_director] hold repair: re-issued %d displaced wait order(s)", n);
        PrintToServer("[respawn_director] hold repair: re-issued %d displaced wait order(s)", n);
    }
    return Plugin_Continue;
}

/* ---------- give: what All4Dead2 cannot do over rcon ------------------------ */

/**
 * a4d_spawn_weapon / a4d_spawn_item route through the `give` console command, which
 * hard-refuses a console caller — measured 2026-08-30, they answer "Can not use this
 * command from the console" even with players connected, so they are permanently
 * unavailable to the agent (see docs/spikes/S2.md).
 *
 * GivePlayerItem is a SourceMod native: no console, no sv_cheats, no player-caller
 * requirement. It also spawns items the current map never places, which is the point
 * — the map's own spawns are irrelevant to what the agent can hand you.
 */
public Action Cmd_Give(int client, int args)
{
    if (args < 1)
    {
        ReplyToCommand(client, "ERR|usage|sm_rd_give <entity_name> [player]  e.g. weapon_rifle_m60");
        return Plugin_Handled;
    }

    if (!g_cvAllowGive.BoolValue)
    {
        /* Say WHY and name the switch: a refusal nobody can act on reads as a bug. */
        ReplyToCommand(client, "ERR|disabled|item granting is off|set rd_allow_give 1 to enable (operator decision)");
        return Plugin_Handled;
    }

    char item[64];
    GetCmdArg(1, item, sizeof(item));

    /* Guard the obvious footgun: an unprefixed name silently creates nothing. */
    if (strncmp(item, "weapon_", 7) != 0 && strncmp(item, "upgrade_", 8) != 0)
    {
        ReplyToCommand(client, "ERR|bad_name|%s|entity names start with weapon_ or upgrade_", item);
        return Plugin_Handled;
    }

    int target = 0;
    if (args >= 2)
    {
        char who[MAX_NAME_LENGTH];
        GetCmdArg(2, who, sizeof(who));
        for (int i = 1; i <= MaxClients; i++)
        {
            if (!IsClientInGame(i)) continue;
            char n[MAX_NAME_LENGTH]; GetClientName(i, n, sizeof(n));
            if (StrContains(n, who, false) != -1) { target = i; break; }
        }
        if (target == 0)
        {
            ReplyToCommand(client, "ERR|no_such_player|%s", who);
            return Plugin_Handled;
        }
    }
    else target = FindHuman();

    if (target == 0 || !IsPlayerAlive(target))
    {
        ReplyToCommand(client, "ERR|no_target|nobody alive to give it to");
        return Plugin_Handled;
    }

    int ent = GivePlayerItem(target, item);
    char n[MAX_NAME_LENGTH]; GetClientName(target, n, sizeof(n));
    if (ent == -1)
        ReplyToCommand(client, "ERR|give_failed|%s|to=%s|is that a real entity name?", item, n);
    else
        ReplyToCommand(client, "OK|gave|%s|to=%s", item, n);
    return Plugin_Handled;
}

/* ---------- scene: what is actually happening ------------------------------ */

/* Ordered by how much a survivor should care, NOT by health or rarity. A Tank is
   obviously top; a Charger outranks a Hunter because it arrives whether or not you
   saw it coming; a Boomer is last as a threat but first as a *cause* of one, which
   is why the agent gets the type and decides rather than only getting a score. */
static int ThreatRank(int zclass)
{
    switch (zclass)
    {
        case 8: return 100;   // Tank
        case 7: return 90;    // Witch
        case 6: return 60;    // Charger
        case 3: return 50;    // Hunter
        case 5: return 45;    // Jockey
        case 1: return 40;    // Smoker
        case 4: return 30;    // Spitter
        case 2: return 20;    // Boomer
    }
    return 0;
}

static void ZClassName(int zclass, char[] out, int maxlen)
{
    static const char names[][] =
        { "none", "smoker", "boomer", "hunter", "spitter", "jockey", "charger", "witch", "tank" };
    strcopy(out, maxlen, (zclass >= 0 && zclass < sizeof(names)) ? names[zclass] : "unknown");
}

/** Bearing of `target` relative to where `client` is facing: 0 = ahead, +/-180 = behind. */
static float BearingTo(int client, const float target[3])
{
    float eye[3], ang[3];
    GetClientEyePosition(client, eye);
    GetClientEyeAngles(client, ang);
    float yaw = ArcTangent2(target[1] - eye[1], target[0] - eye[0]) * (180.0 / FLOAT_PI);
    float d = yaw - ang[1];
    while (d > 180.0)  d -= 360.0;
    while (d < -180.0) d += 360.0;
    return d;
}

/** Is it moving toward the point? Velocity projected onto the bearing. */
static bool IsClosing(const float from[3], const float vel[3], const float toward[3])
{
    float dir[3];
    SubtractVectors(toward, from, dir);
    if (NormalizeVector(dir, dir) <= 0.0)
        return false;
    return (GetVectorDotProduct(dir, vel) > 40.0);   // ignore idle jitter
}

public Action Cmd_Scene(int client, int args)
{
    /* Anchor on the first human — bearings and distances need a viewpoint, and the
       human is the one whose situation the agent is reasoning about. */
    int me = FindHuman();
    if (me == 0)
    {
        ReplyToCommand(client, "ERR|no_human|nothing to describe; nobody is connected");
        return Plugin_Handled;
    }

    float mypos[3];
    GetClientAbsOrigin(me, mypos);

    /* Flow is only meaningful once the nav mesh and the round are up. Measured
       returning small NEGATIVE values in the safe room and 0 before the round
       starts, so a naive percentage prints "-2%" — a number that looks real and is
       not. Report it as unknown rather than confidently wrong: the agent should be
       able to trust every field it reads here or the readout is worse than nothing. */
    float maxflow = L4D2Direct_GetMapMaxFlowDistance();
    float myflow  = L4D2Direct_GetFlowDistance(me);
    char flowStr[8];
    if (maxflow > 0.0 && myflow >= 0.0)
        FormatEx(flowStr, sizeof(flowStr), "%d%%", RoundToNearest((myflow / maxflow) * 100.0));
    else
        strcopy(flowStr, sizeof(flowStr), "?");

    ReplyToCommand(client, "SCENE|flow=%s|intensity=%.2f", flowStr, L4D_GetAvgSurvivorIntensity());

    /* Survivors, humans and bots alike — the agent needs the team's state, not just
       the speaker's. */
    for (int i = 1; i <= MaxClients; i++)
    {
        if (!IsClientInGame(i) || GetClientTeam(i) != 2 || !IsPlayerAlive(i))
            continue;
        char n[MAX_NAME_LENGTH];
        GetClientName(i, n, sizeof(n));
        float p[3]; GetClientAbsOrigin(i, p);
        ReplyToCommand(client, "SURV|%s|%s|hp=%d+%d|dist=%d|incap=%d|threats=%d",
            n, IsFakeClient(i) ? "bot" : "human",
            GetClientHealth(i), L4D_GetPlayerTempHealth(i),
            RoundToNearest(GetVectorDistance(mypos, p)),
            L4D_IsPlayerIncapacitated(i) ? 1 : 0,
            L4D_HasVisibleThreats(i) ? 1 : 0);
    }

    /* Special infected: each one named, placed, and judged. */
    int topRank = -1; char topName[16]; int topDist = 0;
    for (int i = 1; i <= MaxClients; i++)
    {
        if (!IsClientInGame(i) || GetClientTeam(i) != 3 || !IsPlayerAlive(i))
            continue;
        int zc = GetEntProp(i, Prop_Send, "m_zombieClass");
        char cname[16]; ZClassName(zc, cname, sizeof(cname));
        float p[3], v[3];
        GetClientAbsOrigin(i, p);
        GetEntPropVector(i, Prop_Data, "m_vecVelocity", v);
        int dist = RoundToNearest(GetVectorDistance(mypos, p));
        ReplyToCommand(client, "SI|%s|dist=%d|bearing=%d|closing=%d|rank=%d",
            cname, dist, RoundToNearest(BearingTo(me, p)),
            IsClosing(p, v, mypos) ? 1 : 0, ThreatRank(zc));
        if (ThreatRank(zc) > topRank) { topRank = ThreatRank(zc); strcopy(topName, sizeof(topName), cname); topDist = dist; }
    }

    /* Witches are entities, not players, so they need their own sweep. */
    int ent = -1;
    while ((ent = FindEntityByClassname(ent, "witch")) != -1)
    {
        float p[3]; GetEntPropVector(ent, Prop_Send, "m_vecOrigin", p);
        int dist = RoundToNearest(GetVectorDistance(mypos, p));
        ReplyToCommand(client, "SI|witch|dist=%d|bearing=%d|closing=0|rank=%d",
            dist, RoundToNearest(BearingTo(me, p)), ThreatRank(7));
        if (ThreatRank(7) > topRank) { topRank = ThreatRank(7); strcopy(topName, sizeof(topName), "witch"); topDist = dist; }
    }

    /* Commons: a count and the nearest, because 40 of them is one fact, not 40. */
    int commons = 0, nearest = 999999;
    ent = -1;
    while ((ent = FindEntityByClassname(ent, "infected")) != -1)
    {
        float p[3]; GetEntPropVector(ent, Prop_Send, "m_vecOrigin", p);
        int d = RoundToNearest(GetVectorDistance(mypos, p));
        commons++;
        if (d < nearest) nearest = d;
    }
    ReplyToCommand(client, "MOB|commons=%d|nearest=%d", commons, (commons > 0) ? nearest : -1);

    if (topRank > 0)
        ReplyToCommand(client, "TOP|%s|dist=%d|rank=%d", topName, topDist, topRank);
    else
        ReplyToCommand(client, "TOP|none");

    return Plugin_Handled;
}

/* ---------- status --------------------------------------------------------- */

public Action Cmd_Status(int client, int args)
{
    int humans = 0, bots = 0, infected = 0;
    char names[512];
    for (int i = 1; i <= MaxClients; i++)
    {
        if (!IsClientInGame(i))
            continue;
        if (IsFakeClient(i))
        {
            /* Only LIVING SURVIVOR bots. It used to count every fake client, so AI
               specials on the other team inflated the number an agent reads to decide
               whether it can order anything — measured reporting bots=5 (Coach, Ellis,
               Rochelle, Jockey, Hunter) on a server with two orderable bots, one of the
               named three already gone. */
            if (GetClientTeam(i) != 2 || !IsPlayerAlive(i))
            {
                if (GetClientTeam(i) == 3) infected++;
                continue;
            }
            bots++;
            char n[MAX_NAME_LENGTH];
            GetClientName(i, n, sizeof(n));
            if (names[0] != '\0')
                StrCat(names, sizeof(names), ",");
            StrCat(names, sizeof(names), n);
        }
        else humans++;
    }
    /* orders_ready no longer tracks whether a human is connected — v3 needs none. It
       tracks the thing that actually gates an order now, which is whether Left4Bots is
       loaded and running a mode. Reporting the old condition would have said "ready"
       on a server where every order silently fails. */
    ReplyToCommand(client, "STATUS|humans=%d|bots=%d|botnames=%s|infected_ai=%d|orders_ready=%d|inbox=%d|api=vscript",
        humans, bots, names, infected, L4BReady() ? 1 : 0, g_Inbox.Length);
    return Plugin_Handled;
}
