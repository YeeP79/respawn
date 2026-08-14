import { RemovalPolicy } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { Environment } from '@respawn/core';
import { logGroupName } from '@respawn/core';

const RETENTION_MAP: Record<number, logs.RetentionDays> = {
  1: logs.RetentionDays.ONE_DAY,
  3: logs.RetentionDays.THREE_DAYS,
  5: logs.RetentionDays.FIVE_DAYS,
  7: logs.RetentionDays.ONE_WEEK,
  14: logs.RetentionDays.TWO_WEEKS,
  30: logs.RetentionDays.ONE_MONTH,
  60: logs.RetentionDays.TWO_MONTHS,
  90: logs.RetentionDays.THREE_MONTHS,
  120: logs.RetentionDays.FOUR_MONTHS,
  150: logs.RetentionDays.FIVE_MONTHS,
  180: logs.RetentionDays.SIX_MONTHS,
  365: logs.RetentionDays.ONE_YEAR,
  400: logs.RetentionDays.THIRTEEN_MONTHS,
  545: logs.RetentionDays.EIGHTEEN_MONTHS,
  731: logs.RetentionDays.TWO_YEARS,
  1827: logs.RetentionDays.FIVE_YEARS,
  2192: logs.RetentionDays.SIX_YEARS,
  2557: logs.RetentionDays.SEVEN_YEARS,
  2922: logs.RetentionDays.EIGHT_YEARS,
  3288: logs.RetentionDays.NINE_YEARS,
  3653: logs.RetentionDays.TEN_YEARS,
};

function mapRetentionDays(days: number): logs.RetentionDays {
  const mapped = RETENTION_MAP[days];
  if (mapped !== undefined) return mapped;
  // Fall back to nearest lower valid retention
  const validDays = Object.keys(RETENTION_MAP)
    .map(Number)
    .sort((a, b) => a - b);
  for (let i = validDays.length - 1; i >= 0; i--) {
    if (validDays[i]! <= days) return RETENTION_MAP[validDays[i]!]!;
  }
  return logs.RetentionDays.ONE_WEEK;
}

export interface GameServerLoggingProps {
  serviceName: string;
  environment: Environment;
  retentionDays: number;
}

/**
 * Masks a join/connect password out of the log stream.
 *
 * Game engines log the client's full connect URL on every login, and for a
 * password-protected server that URL carries the password in the clear. Verified on
 * ut99, where each join writes:
 *
 *   Login request: CTF-Gauntlet.unr?Name=...?password=<secret>?game=Botpack.CTFGame
 *
 * That turns a Secrets Manager value into something any reader of the log group can
 * lift, which is a far wider audience than the people meant to have it. The engine
 * decides what it logs and takes no flag to stop, and the awslogs driver cannot
 * filter, so masking at the log group is the only interception point short of a
 * FireLens sidecar.
 *
 * Deliberately matched on the generic `password=` rather than anything ut99-specific:
 * this construct backs every game, and a connect string in a URL query is the common
 * shape across them.
 *
 * Two limits worth knowing. Masking applies at ingestion, so it does NOT retroactively
 * mask events already written — an exposed password stays exposed in the existing
 * stream and must be rotated. And data protection bills per GB scanned, on top of
 * ingestion.
 */
const JOIN_PASSWORD_IDENTIFIER = new logs.CustomDataIdentifier(
  'JoinPassword',
  '[Pp]assword=[^?&\\s]+',
);

export class GameServerLogging extends Construct {
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: GameServerLoggingProps) {
    super(scope, id);

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: logGroupName(props.environment, props.serviceName),
      retention: mapRetentionDays(props.retentionDays),
      removalPolicy: RemovalPolicy.DESTROY,
      dataProtectionPolicy: new logs.DataProtectionPolicy({
        name: 'respawn-mask-credentials',
        description: 'Masks connect-URL passwords the game engine logs on login',
        identifiers: [JOIN_PASSWORD_IDENTIFIER],
      }),
    });
  }
}
