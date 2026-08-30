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
 * rcon executes as Console<0>, which is not a player entity, so the agent cannot
 * issue orders directly no matter what permissions it holds. That is structural,
 * not a configuration problem (measured — see docs/spikes/S10.md).
 *
 * The fix is the same trick All4Dead2 already uses and which this repo has verified
 * working live: impersonate a connected human with FakeClientCommand. Orders only
 * matter while somebody is playing, and while somebody is playing there is always a
 * player to impersonate — so the degenerate case needs no handling.
 *
 * It is also two-way. The agent cannot watch chat (server log echo proved
 * unreliable — it died mid-session during S10 and took four readings with it), so
 * this plugin owns an inbox the agent drains over rcon. Nothing outside this plugin
 * can break it.
 *
 * COMMANDS (all ADMFLAG_ROOT; rcon satisfies that as Console<0> — see S2)
 *   sm_rd_inbox            drain pending player messages, one per line
 *   sm_rd_order <src> <cmd...>   issue an L4B order as a real player
 *   sm_rd_status           bots, humans, and whether an order can be issued
 */

#include <sourcemod>
#include <sdktools>
#include <left4dhooks>

#pragma semicolon 1
#pragma newdecls required

#define PLUGIN_VERSION "0.2.0"
#define INBOX_MAX      64
#define MSG_MAXLEN     192

public Plugin myinfo =
{
    name        = "respawn_director",
    author      = "respawn",
    description = "Agent bridge for Left 4 Bots 2: order injection + a chat inbox",
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

    RegAdminCmd("sm_rd_inbox",  Cmd_Inbox,  ADMFLAG_ROOT, "Drain pending player messages");
    RegAdminCmd("sm_rd_order",  Cmd_Order,  ADMFLAG_ROOT, "Issue an L4B order: sm_rd_order <botsource> <command...>");
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

/** First connected human. L4B needs a player entity; any real one satisfies it. */
static int FindHuman()
{
    for (int i = 1; i <= MaxClients; i++)
        if (IsClientInGame(i) && !IsFakeClient(i))
            return i;
    return 0;
}

public Action Cmd_Order(int client, int args)
{
    if (args < 2)
    {
        ReplyToCommand(client, "ERR|usage|sm_rd_order <bots|bot|botname> <command> [param]");
        return Plugin_Handled;
    }

    int human = FindHuman();
    if (human == 0)
    {
        /* Not a failure worth retrying: with nobody connected there are no bots to
           command either. Say so plainly rather than returning a generic error. */
        ReplyToCommand(client, "ERR|no_human|L4B orders require a player entity; nobody is connected");
        return Plugin_Handled;
    }

    char src[64], rest[160];
    GetCmdArg(1, src, sizeof(src));
    GetCmdArgString(rest, sizeof(rest));

    /* Re-join everything after the botsource, comma-separated, because
       scripted_user_func takes  l4b,<botsource>,<command>[,<param>]  */
    int skip = strlen(src);
    char tail[160];
    strcopy(tail, sizeof(tail), rest[skip]);
    TrimString(tail);
    ReplaceString(tail, sizeof(tail), " ", ",");

    char full[256];
    Format(full, sizeof(full), "scripted_user_func l4b,%s,%s", src, tail);
    FakeClientCommand(human, "%s", full);

    char hname[MAX_NAME_LENGTH];
    GetClientName(human, hname, sizeof(hname));
    ReplyToCommand(client, "OK|sent|as=%s|cmd=%s", hname, full);
    return Plugin_Handled;
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
    int humans = 0, bots = 0;
    char names[512];
    for (int i = 1; i <= MaxClients; i++)
    {
        if (!IsClientInGame(i))
            continue;
        if (IsFakeClient(i))
        {
            bots++;
            char n[MAX_NAME_LENGTH];
            GetClientName(i, n, sizeof(n));
            if (names[0] != '\0')
                StrCat(names, sizeof(names), ",");
            StrCat(names, sizeof(names), n);
        }
        else humans++;
    }
    ReplyToCommand(client, "STATUS|humans=%d|bots=%d|botnames=%s|orders_ready=%d|inbox=%d",
        humans, bots, names, (humans > 0) ? 1 : 0, g_Inbox.Length);
    return Plugin_Handled;
}
