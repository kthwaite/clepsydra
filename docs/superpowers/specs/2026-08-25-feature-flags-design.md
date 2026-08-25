# Feature Flags Design

## Purpose

Clepsydra needs startup-controlled feature flags. The first flags control Academic and Feeds. A disabled feature must be unavailable across the UI, HTTP API, runtime work, diagnostics, and runtime API documentation.

Existing installations must retain their current behavior when they do not configure the new section.

## Configuration

Application `config.toml` gains a top-level feature section:

```toml
[features]
academic = true
feeds = true
```

Both fields default to `true`. An omitted `[features]` section therefore preserves current behavior.

The existing environment layer supports overrides without new parsing rules:

```text
CLEPSYDRA__FEATURES__ACADEMIC=false
CLEPSYDRA__FEATURES__FEEDS=false
```

Configuration is read once at startup. Changing a flag requires a server restart. Invalid boolean values fail startup through the existing configuration error path.

`Settings` owns a typed `FeatureFlags` value. Backend route construction, optional runtime construction, diagnostics, and the capability response all consume this same immutable snapshot. Feature-specific code must not read environment variables or configuration independently.

## Capability API

The always-available `GET /api/features` endpoint returns the effective feature snapshot:

```json
{
  "academic": true,
  "feeds": false
}
```

The UI uses this response as the authority for feature availability. A capability request failure fails closed for optional product surfaces: the UI does not display Academic or Feeds navigation or commands while availability is unknown.

The endpoint reports effective values after defaults, configuration, and environment overrides have been applied.

## Backend Boundaries

### Academic

When Academic is enabled, its current API router is nested unchanged.

When Academic is disabled:

- `/api/vault/academic/*` is not mounted.
- Requests to those paths receive the standard unknown-route `404` response.
- Academic-specific doctor checks report `SKIP` and identify the disabled feature as the reason.
- Existing academic pages and metadata remain untouched.

Academic has no independent background runtime to stop.

### Feeds

Feed storage, networking, synchronization primitives, and settings become one optional runtime unit owned by application state.

When Feeds is enabled, Clepsydra preserves current behavior: it opens `.clepsydra/feeds.db`, creates the checked feed HTTP client, reconciles `feeds.md`, listens for manifest changes, and owns the scheduler for the serving lifetime.

When Feeds is disabled:

- `/api/vault/feeds/*` is not mounted.
- Requests to those paths receive the standard unknown-route `404` response.
- Clepsydra does not open or create `.clepsydra/feeds.db`.
- Clepsydra does not create the feed HTTP client.
- Clepsydra does not read or reconcile `feeds.md`.
- Vault watcher batches do not trigger feed notifications.
- Clepsydra does not start the feed scheduler.
- Existing `feeds.md` and `.clepsydra/feeds.db` files remain untouched.

Re-enabling Feeds restores access to the same persisted data.

The optional runtime is a single unit rather than several unrelated `Option` fields. Enabled feed handlers receive a complete runtime. No handler may execute with a partially initialized feed subsystem.

## Router and OpenAPI Composition

Feature decisions occur when the application router is built. Disabled feature routers are absent rather than mounted behind repeated handler-level checks. This makes unknown and disabled paths indistinguishable to HTTP clients and prevents guard drift between endpoints.

The runtime OpenAPI document omits paths and feature tags for disabled features. Build-time OpenAPI generation remains a superset containing both features so the generated TypeScript client supports every valid deployment configuration.

## UI Behavior

The application resolves capabilities before rendering feature-dependent navigation.

When a feature is disabled or capability availability is unknown:

- Its desktop navigation item is absent.
- Its mobile navigation item is absent.
- Its command-palette actions are absent.
- Direct navigation to `/academic` or `/feeds` renders the existing not-found surface.
- Rendering the not-found surface does not issue requests to the disabled feature API.

Documentation remains available. Feature documentation explains the relevant configuration keys and restart requirement.

The route files remain compiled into the shared UI bundle. Runtime capability checks decide whether those routes can render their feature components.

## Configuration and Diagnostics UX

`clepsydra config create` includes a commented `[features]` section. It documents both defaults and both environment key forms.

`clepsydra config show` continues to show the selected file without synthesizing omitted defaults.

Doctor output reports the effective state of Academic and Feeds. Disabled feature checks use `SKIP`, not `WARN` or `ERR`, because intentional disablement is healthy configuration.

## Lifecycle and Data Safety

Flags are immutable for the serving lifetime. There is no runtime toggle API and no settings UI in this change.

Normal server shutdown owns any enabled feed scheduler through its existing cancellation and join path. No disabled feed task exists to cancel.

Disabling a feature never migrates, deletes, renames, or rewrites vault content or internal databases. Requests already in flight during server shutdown follow existing shutdown behavior.

## Testing Strategy

Implementation follows test-driven development. Tests first establish these observable contracts:

1. Missing feature configuration enables both features.
2. File configuration and environment overrides resolve through existing precedence.
3. The capability endpoint returns effective values.
4. Disabled Academic and Feeds API paths return `404`.
5. Disabled Feeds creates no database, client, manifest reconciliation, watcher notification, or scheduler.
6. Enabled features preserve current backend behavior.
7. Runtime OpenAPI omits disabled feature paths and tags.
8. Desktop navigation, mobile navigation, and command-palette actions follow capabilities.
9. Disabled direct UI routes render not found without feature API requests.
10. The config template documents flags and doctor reports effective states.

Tests should use the central feature snapshot and router/runtime constructors. They must not rely on process-global environment mutation where an injected settings value can prove the same contract.

## Verification Gates

Before integration:

- Rust typecheck passes.
- UI typecheck passes.
- Rust lint passes with warnings denied.
- UI lint passes.
- The Rust test suite passes.
- The UI test suite passes.
- A smoke test starts Clepsydra with both features disabled and verifies the capability response, absent API routes, absent UI surfaces, direct-route rejection, and absence of feed runtime side effects.

## Out of Scope

- Per-user, per-vault, or percentage rollout rules.
- Runtime flag changes.
- A feature-management settings UI.
- Remote flag services.
- Cargo compile-time feature removal.
- Flags for features other than Academic and Feeds.
