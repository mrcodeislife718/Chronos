# Chronos Roadmap

Chronos is the Cannon cloud build, deploy, update, and release platform.

## Product contract

Chronos owns reproducible remote builds, build isolation, signing/credentials, artifacts, previews, deployments, release channels, staged rollouts, over-the-air updates where platforms permit them, rollback, build history, and deployment observability.

## Design sources

Chronos combines EAS-style native build automation with Vercel-style previews and deployment ergonomics while avoiding mandatory cloud lock-in and unpredictable infrastructure behavior.

## Implementation order

1. Reproducible containerized build runner.
2. Artifact store and build metadata.
3. Web preview deployments.
4. Release channels and rollback.
5. Android remote builds/signing.
6. iOS remote builds/signing.
7. OTA update service for eligible assets/runtime layers.
8. Team/enterprise policy, audit, and private runners.

## Proof gates

Builds require reproducibility tests from clean environments. Deployments require health checks and rollback tests. Signing support requires verified installable artifacts on the target platform.

## Commercial boundary

Chronos is a primary revenue product: build minutes, artifact storage, bandwidth, preview environments, signing management, deployment seats, private runners, enterprise SLAs, and support.
