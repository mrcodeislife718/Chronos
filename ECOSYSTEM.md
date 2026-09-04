# Chronos ecosystem role

Chronos is the Cannon cloud build, deploy, update and release platform.

## Intent

Chronos turns source code into reproducible, signed, traceable and deployable products. It is the managed/private infrastructure counterpart to Velocity's local application-development workflow.

Chronos owns reproducible remote builds, isolated builders, toolchain pinning, signing/credentials, artifact storage and provenance, preview deployments, deployment history, release channels, staged rollouts, eligible over-the-air updates, rollback, health/verification gates and deployment observability.

For web applications this means reproducible production builds, previews, deployment and rollback. For Android/iOS it includes controlled remote toolchains, signing and installable artifacts. For desktop it includes packaging/signing/release artifacts. Enterprise deployments can use private runners rather than mandatory shared-cloud infrastructure.

## Relationships

- Cannon/Cannon+ are source languages.
- Nova supplies the compiler/toolchain.
- Parallel supplies the runtime.
- Sprout/Cadence form application layers.
- Velocity owns local project/dev/target orchestration and hands remote build/release work to Chronos.
- Plasma participates where native/foreign modules must be built.
- Scout can carry deterministic build/deployment configuration.
- Cortex exposes build, release, evidence and deployment controls to developers.

## Commercial role

Chronos is a primary direct-revenue surface for the developer ecosystem: build minutes, artifact storage, bandwidth, preview environments, signing management, deployment seats, private runners, enterprise policy/audit, SLAs and support.

## Boundary

Chronos must not become mandatory for using Cannon or Velocity. Local development remains independent; Chronos earns its place through reproducibility, convenience, security, evidence, scale and release operations rather than lock-in.
