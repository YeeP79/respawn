#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import type { Environment } from '../config/types.js';
import { SharedStack } from '../stacks/shared-stack.js';
import { GameServerStack } from '../stacks/game-server-stack.js';
import { discoverServices } from '../utils/stack-discovery.js';

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

// Resolve every service through discovery — the single source of truth for the
// apps/ layout, including the variants/ layout. An id no longer has to be a real
// apps/<id> directory (a variant lives at apps/<project>/variants/<v>/), so requested
// names are matched against discovered service names rather than a path guess.
const allDiscovered = discoverServices(workspaceRoot, environment);
const byName = new Map(allDiscovered.map((s) => [s.name, s]));

const requestedNames = new Set(serviceNames);
const discoveredServices = serviceNames.map((name) => {
  const svc = byName.get(name);
  if (!svc) {
    throw new Error(
      `Unknown service "${name}". Discovered: ${
        allDiscovered.map((s) => s.name).join(', ') || '(none)'
      }.`,
    );
  }
  Object.assign(svc.config.gameEnvVars, gameEnvOverrides);
  return svc;
});

// EVERY service stack must be synthesized on every run, even when deploying just
// one, so the shared stack's exports stay stable. CDK auto-generates a cross-stack
// export for a repo/VPC only when a stack references it in this same synth; if
// service A's stack is absent, its export disappears from the shared template, and
// CloudFormation refuses to remove an export that A's still-deployed stack imports
// (the update rolls back). The `stacks` argument to `cdk deploy` still limits what
// actually deploys — synthesizing all of them costs nothing.
const otherServices = allDiscovered.filter((s) => !requestedNames.has(s.name));
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
