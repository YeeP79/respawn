#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import type { Environment } from '@respawn/core';
import { SharedStack } from '../stacks/shared-stack.js';
import { GameServerStack } from '../stacks/game-server-stack.js';
import { discoverServices, sharedStackId, serviceStackId } from '@respawn/core';

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

// Every stack in one synth shares a single environment: each service stack references
// the shared stack's VPC, and CDK rejects a cross-*region* reference outright (the
// synth throws before anything deploys). Two consequences.
//
// First, the requested services must agree on a region. They almost always do; when
// they do not, say so plainly here rather than let CDK report it as an unresolvable
// reference between two stack names, which does not hint at the .env that caused it.
const requestedRegions = [
  ...new Set(discoveredServices.map((s) => s.config.aws.region)),
];
if (requestedRegions.length > 1) {
  const byRegion = discoveredServices
    .map((s) => `  ${s.name}: ${s.config.aws.region}`)
    .join('\n');
  throw new Error(
    `Cannot deploy services from different regions in one run — they share a VPC ` +
      `from the shared stack, and CDK does not allow a cross-region reference to it.\n` +
      `${byRegion}\n` +
      `Deploy one region at a time, or align AWS_REGION across these services' .env files.`,
  );
}

// Second, the synth-only stacks (everything not requested) must be pinned to that
// same region instead of their own .env. They are never deployed — they exist only so
// the shared stack's exports stay stable, per the note above — so their region is
// immaterial, but leaving it at the .env value makes them reference the shared VPC
// across regions and fail the synth. This is what lets one service be retargeted to
// another account/region while the rest of the fleet stays put.
const synthRegion = discoveredServices[0]?.config.aws.region ?? 'us-east-1';

// The declared account wins over CDK_DEFAULT_ACCOUNT. Those two are independent —
// AWS_ACCOUNT_ID is a value in .env, CDK_DEFAULT_ACCOUNT comes from whichever profile
// the CLI resolved — and nothing used to reconcile them, so declaring one account and
// running with another profile deployed to the profile's account without a word.
// Preferring the declaration makes the .env the single source of truth and turns that
// silent mistake into a loud one: CloudFormation refuses to touch a stack whose
// template targets an account the credentials do not belong to.
const requestedAccounts = [
  ...new Set(discoveredServices.map((s) => s.config.aws.accountId).filter(Boolean)),
];
if (requestedAccounts.length > 1) {
  const byAccount = discoveredServices
    .map((s) => `  ${s.name}: ${s.config.aws.accountId ?? '(unset)'}`)
    .join('\n');
  throw new Error(
    `Cannot deploy services from different AWS accounts in one run — they share the ` +
      `shared stack's VPC, and one synth targets one account.\n${byAccount}`,
  );
}
const synthAccount = requestedAccounts[0] ?? process.env['CDK_DEFAULT_ACCOUNT'];

const allEcrServices = allServices.filter((s) => !s.config.image.imageUri);
const allImageUriServices = allServices.filter((s) => !!s.config.image.imageUri);

// Shared stack (VPC, ECR repos) — a repo for every local-build service.
const sharedStack = new SharedStack(app, sharedStackId(environment), {
  environment,
  services: allEcrServices,
  env: {
    account: synthAccount,
    region: synthRegion,
  },
});

// Per-service stacks — ECR-based services
for (const svc of allEcrServices) {
  const ecrRepo = sharedStack.ecrRepos.get(svc.name);
  if (!ecrRepo) {
    throw new Error(`No ECR repo found for service: ${svc.name}`);
  }

  const serviceStack = new GameServerStack(app, serviceStackId(environment, svc.name), {
    config: svc.config,
    vpc: sharedStack.vpc,
    ecrRepository: ecrRepo.repository,
    // Only the requested service actually deploys, so its tag is the real one;
    // others are synthesized but not deployed, so their tag is immaterial.
    imageTag: requestedNames.has(svc.name) ? imageTag : `${environment}-latest`,
    env: {
      account: synthAccount,
      region: synthRegion,
    },
  });

  serviceStack.addDependency(sharedStack);
}

// Per-service stacks — IMAGE_URI-based services (no ECR repo needed)
for (const svc of allImageUriServices) {
  const serviceStack = new GameServerStack(app, serviceStackId(environment, svc.name), {
    config: svc.config,
    vpc: sharedStack.vpc,
    imageUri: svc.config.image.imageUri,
    env: {
      account: synthAccount,
      region: synthRegion,
    },
  });

  serviceStack.addDependency(sharedStack);
}

app.synth();
