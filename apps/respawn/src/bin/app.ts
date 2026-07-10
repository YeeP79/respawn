#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import type { Environment } from '../config/types.js';
import { loadConfig } from '../config/loader.js';
import { SharedStack } from '../stacks/shared-stack.js';
import { GameServerStack } from '../stacks/game-server-stack.js';
import { discoverServices } from '../utils/stack-discovery.js';
import * as path from 'node:path';

const app = new cdk.App();

const environment = app.node.tryGetContext('environment') as Environment;
const servicesRaw = app.node.tryGetContext('services') as string;
const imageTag = (app.node.tryGetContext('imageTag') as string) || 'latest';
const workspaceRoot = app.node.tryGetContext('workspaceRoot') as string;

if (!environment) {
  throw new Error('Context value "environment" is required (-c environment=dev)');
}
if (!servicesRaw) {
  throw new Error('Context value "services" is required (-c services=service-alpha,service-bravo)');
}
if (!workspaceRoot) {
  throw new Error('Context value "workspaceRoot" is required (-c workspaceRoot=/path/to/workspace)');
}

const serviceNames = servicesRaw.split(',').map((s) => s.trim());

// Deploy-time prompt answers (interactive deploy only) arrive as a JSON map of
// container env var → chosen value, and override the .env GAME_ENV_ defaults.
const gameEnvOverridesRaw = app.node.tryGetContext('gameEnvOverrides') as
  | string
  | undefined;
const gameEnvOverrides: Record<string, string> = gameEnvOverridesRaw
  ? JSON.parse(gameEnvOverridesRaw)
  : {};

// Load configs for each service
const discoveredServices = serviceNames.map((name) => {
  const servicePath = path.resolve(workspaceRoot, 'apps', name);
  const config = loadConfig(servicePath, environment);
  Object.assign(config.gameEnvVars, gameEnvOverrides);
  return { name, path: servicePath, config };
});

// EVERY service stack must be synthesized on every run, even when deploying just
// one, so the shared stack's exports stay stable. CDK auto-generates a cross-stack
// export for a repo/VPC only when a stack references it in this same synth; if
// service A's stack is absent, its export disappears from the shared template, and
// CloudFormation refuses to remove an export that A's still-deployed stack imports
// (the update rolls back). The `stacks` argument to `cdk deploy` still limits what
// actually deploys — synthesizing all of them costs nothing.
//
// Requested services keep loud config errors (discoveredServices threw on load);
// the rest come from discovery, which skips a broken .env with a warning.
const requestedNames = new Set(serviceNames);
const otherServices = discoverServices(workspaceRoot, environment).filter(
  (s) => !requestedNames.has(s.name),
);
const allServices = [...discoveredServices, ...otherServices];

const allEcrServices = allServices.filter((s) => !s.config.image.imageUri);
const allImageUriServices = allServices.filter((s) => !!s.config.image.imageUri);

// Shared stack (VPC, ECR repos) — a repo for every local-build service.
const sharedStack = new SharedStack(app, `RespawnShared-${environment}`, {
  environment,
  services: allEcrServices,
  env: {
    account: process.env['CDK_DEFAULT_ACCOUNT'],
    region: discoveredServices[0]?.config.aws.region ?? 'us-east-1',
  },
});

// Per-service stacks — ECR-based services
for (const svc of allEcrServices) {
  const ecrRepo = sharedStack.ecrRepos.get(svc.name);
  if (!ecrRepo) {
    throw new Error(`No ECR repo found for service: ${svc.name}`);
  }

  const serviceStack = new GameServerStack(app, `Respawn-${environment}-${svc.name}`, {
    config: svc.config,
    vpc: sharedStack.vpc,
    ecrRepository: ecrRepo.repository,
    // Only the requested service actually deploys, so its tag is the real one;
    // others are synthesized but not deployed, so their tag is immaterial.
    imageTag: requestedNames.has(svc.name) ? imageTag : `${environment}-latest`,
    env: {
      account: process.env['CDK_DEFAULT_ACCOUNT'],
      region: svc.config.aws.region,
    },
  });

  serviceStack.addDependency(sharedStack);
}

// Per-service stacks — IMAGE_URI-based services (no ECR repo needed)
for (const svc of allImageUriServices) {
  const serviceStack = new GameServerStack(app, `Respawn-${environment}-${svc.name}`, {
    config: svc.config,
    vpc: sharedStack.vpc,
    imageUri: svc.config.image.imageUri,
    env: {
      account: process.env['CDK_DEFAULT_ACCOUNT'],
      region: svc.config.aws.region,
    },
  });

  serviceStack.addDependency(sharedStack);
}

app.synth();
