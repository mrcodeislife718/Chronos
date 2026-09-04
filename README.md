# Chronos

Chronos is the Cannon cloud build, deploy, update, and release platform.

Chronos turns source code into reproducible, signed, traceable, and deployable products. It is the remote/managed infrastructure counterpart to Velocity's local application-development workflow.

## Responsibilities

Chronos owns:

- reproducible remote builds;
- isolated build environments and pinned toolchains;
- signing and credential handling;
- artifact storage, provenance, and build history;
- preview environments;
- deployment and release channels;
- staged rollouts;
- eligible over-the-air updates;
- rollback;
- health/verification gates;
- deployment observability;
- private enterprise runners.

## Role in the Cannon developer ecosystem

```text
Cannon / Cannon+
       │
       ▼
      Nova
       │
       ▼
    Parallel
       │
  ┌────┴────┐
  ▼         ▼
Sprout    Cadence
  └────┬────┘
       ▼
    Velocity
       │
       ▼
    Chronos
```

Scout can carry deterministic build/deployment configuration. Plasma participates when native or foreign modules must be built. Cortex exposes build, artifact, release, deployment, evidence, and rollback controls.

## Velocity vs Chronos

Velocity owns local development: project creation, dev server, hot reload, previews, local builds, device workflows, and target orchestration.

Chronos owns remote production operations: reproducible builds, signing, artifacts, previews, releases, deployments, updates, and rollback.

Chronos must not be mandatory for using Cannon or Velocity. It should earn adoption through reproducibility, security, scale, evidence, and operational convenience rather than lock-in.

## Platform examples

For web applications, Chronos can provide clean production builds, previews, deployment history, and rollback.

For Android and iOS, it can provide controlled remote toolchains, signing, build artifacts, release channels, and installation verification.

For desktop applications, it can provide packaging, signing, versioned artifacts, update channels, and rollback.

## Proof standard

Builds require reproducibility tests from clean environments. Deployments require health checks and rollback tests. Signing support requires verified installable artifacts on the target platform.

## Commercial role

Chronos is a primary direct-revenue surface: build minutes, artifact storage, bandwidth, preview environments, signing management, deployment seats, private runners, enterprise policy/audit, SLAs, and support.

See [ECOSYSTEM.md](./ECOSYSTEM.md) and [ROADMAP.md](./ROADMAP.md).
