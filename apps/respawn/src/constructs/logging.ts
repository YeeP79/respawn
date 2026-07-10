import { RemovalPolicy } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { Environment } from '@respawn/core';

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

export class GameServerLogging extends Construct {
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: GameServerLoggingProps) {
    super(scope, id);

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/respawn/${props.environment}/${props.serviceName}`,
      retention: mapRetentionDays(props.retentionDays),
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
