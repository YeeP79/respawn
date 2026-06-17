#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import type { Environment } from '../config/types.js';
import { loadConfig } from '../config/loader.js';
import { SharedStack } from '../stacks/shared-stack.js';
import { GameServerStack } from '../stacks/game-server-stack.js';
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

// Split services into ECR-based and IMAGE_URI-based
const ecrServices = discoveredServices.filter((s) => !s.config.image.imageUri);
const imageUriServices = discoveredServices.filter((s) => !!s.config.image.imageUri);

// Shared stack (VPC, ECR repos) — only create ECR repos for services that need them
const sharedStack = new SharedStack(app, `RespawnShared-${environment}`, {
  environment,
  services: ecrServices,
  env: {
    account: process.env['CDK_DEFAULT_ACCOUNT'],
    region: discoveredServices[0]?.config.aws.region ?? 'us-east-1',
  },
});

// Per-service stacks — ECR-based services
for (const svc of ecrServices) {
  const ecrRepo = sharedStack.ecrRepos.get(svc.name);
  if (!ecrRepo) {
    throw new Error(`No ECR repo found for service: ${svc.name}`);
  }

  const serviceStack = new GameServerStack(app, `Respawn-${environment}-${svc.name}`, {
    config: svc.config,
    vpc: sharedStack.vpc,
    ecrRepository: ecrRepo.repository,
    imageTag,
    env: {
      account: process.env['CDK_DEFAULT_ACCOUNT'],
      region: svc.config.aws.region,
    },
  });

  serviceStack.addDependency(sharedStack);
}

// Per-service stacks — IMAGE_URI-based services (no ECR repo needed)
for (const svc of imageUriServices) {
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
