/**
 * rd_probe — measurement instrument for S12.
 *
 * Answers one question: does L4D2_ExecVScriptCode reach Left4Bots.BotOrderAdd?
 * That link is the whole basis of respawn_director v3 and was INFERRED, never run.
 *
 * Two commands, both deliberately dumb:
 *   sm_probe_vs <squirrel>  run VScript and print whatever it puts in <RETURN></RETURN>
 *   sm_probe_bot            spawn a survivor bot (needs l4d_CreateSurvivorBot)
 *
 * sm_probe_vs is the important one. It is a general read/write channel into the VM,
 * so every claim below is measured through the same path v3 will use rather than a
 * friendlier one that might succeed where v3 would not.
 */
#include <sourcemod>
#include <sdktools>
#include <left4dhooks>

#undef REQUIRE_PLUGIN
#include <l4d_CreateSurvivorBot>

#pragma semicolon 1
#pragma newdecls required

public Plugin myinfo =
{
    name        = "rd_probe",
    author      = "respawn",
    description = "S12 measurement: VScript -> Left4Bots.BotOrderAdd",
    version     = "0.1.0",
    url         = ""
};

public void OnPluginStart()
{
    RegAdminCmd("sm_probe_vs",  Cmd_Vs,  ADMFLAG_ROOT, "Run VScript, print <RETURN> payload");
    RegAdminCmd("sm_probe_bot", Cmd_Bot, ADMFLAG_ROOT, "Spawn a survivor bot");
}

public Action Cmd_Vs(int client, int args)
{
    char code[1024];
    GetCmdArgString(code, sizeof(code));
    StripQuotes(code);
    TrimString(code);
    if (code[0] == '\0')
    {
        ReplyToCommand(client, "ERR|usage|sm_probe_vs <squirrel>");
        return Plugin_Handled;
    }

    char buf[1024];
    bool ok = L4D2_GetVScriptOutput(code, buf, sizeof(buf));
    ReplyToCommand(client, "VS|ok=%d|out=%s", ok ? 1 : 0, buf);
    return Plugin_Handled;
}

public Action Cmd_Bot(int client, int args)
{
    if (!CanTestFeatures() || GetFeatureStatus(FeatureType_Native, "CreateSurvivorBot") != FeatureStatus_Available)
    {
        ReplyToCommand(client, "ERR|no_native|CreateSurvivorBot is not loaded");
        return Plugin_Handled;
    }
    int bot = CreateSurvivorBot();
    if (bot < 1)
    {
        ReplyToCommand(client, "ERR|spawn_failed|%d", bot);
        return Plugin_Handled;
    }
    char n[MAX_NAME_LENGTH];
    GetClientName(bot, n, sizeof(n));
    ReplyToCommand(client, "BOT|client=%d|userid=%d|name=%s|team=%d|fake=%d",
        bot, GetClientUserId(bot), n, GetClientTeam(bot), IsFakeClient(bot) ? 1 : 0);
    return Plugin_Handled;
}
