import type { Action, ActionResult, DiscoveredService, Environment } from '@respawn/core';
import { deploy, synth, diff, push, updates, scale } from '@respawn/core';
import { destroy } from './actions/destroy.js';
import { status } from './actions/status.js';

/**
 * The context every action can receive. It is the union of what each action needs;
 * a given action reads only its own fields (deploy uses forceBuild/requireImage/
 * gameEnvOverrides, updates uses record, destroy uses force, ...). One shape lets a
 * single dispatch table serve both the interactive menu and batch mode — the two
 * drifting handler tables that used to live in cli/index.ts and executors/run.ts.
 */
export interface CliActionContext {
  service: DiscoveredService;
  environment: Environment;
  workspaceRoot: string;
  verbose?: boolean;
  profile?: string;
  force?: boolean;
  forceBuild?: boolean;
  requireImage?: boolean;
  record?: boolean;
  requireApproval?: 'never' | 'any-change' | 'broadening';
  gameEnvOverrides?: Record<string, string>;
  /** ECS desiredCount — required by `scale`, ignored by every other action. */
  desiredCount?: number;
}

export type ActionHandler = (ctx: CliActionContext) => Promise<ActionResult>;

/** Single dispatch table shared by interactive and batch mode. */
export const ACTION_HANDLERS: Record<Action, ActionHandler> = {
  deploy: (ctx) => deploy(ctx),
  destroy: (ctx) => destroy(ctx),
  synth: (ctx) => synth(ctx),
  diff: (ctx) => diff(ctx),
  status: (ctx) => status(ctx),
  push: (ctx) => push(ctx),
  updates: (ctx) => updates(ctx),
  scale: (ctx) => scale({ ...ctx, desiredCount: ctx.desiredCount ?? Number.NaN }),
};

/** Human-readable, order-preserving action descriptions for the interactive menu. */
export const ACTION_LABELS: Record<Action, string> = {
  deploy: 'Deploy — Build, push, and deploy game servers',
  push: 'Push — Build and push images to ECR (no deploy)',
  updates: 'Updates — Check for upstream image / game updates',
  scale: 'Scale — Wake (1) or sleep (0) a server without redeploying',
  destroy: 'Destroy — Tear down game server infrastructure',
  synth: 'Synth — Preview CloudFormation templates',
  diff: 'Diff — Show pending infrastructure changes',
  status: 'Status — Check running game server status',
};
