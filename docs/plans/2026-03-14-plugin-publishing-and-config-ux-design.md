## Goal

Make `openclaw-mem0-lancedb` easier to publish as an OpenClaw plugin and easier to configure for end users.

The primary objective is to align the public plugin surface with the current runtime architecture:

- plugin-first installation
- LanceDB as local state authority
- Mem0 as control/sync layer
- explicit maintenance instead of always-on background runtime complexity

The design should remove stale configuration from the published manifest, reduce user confusion, and avoid requiring install scripts as the primary path.

## Non-Goals

- No recall algorithm redesign
- No capture pipeline redesign
- No new maintenance workflow
- No new storage layer or schema expansion

This work is about packaging, configuration UX, and release-facing consistency.

## Current Problems

### 1. The published manifest is stale

`openclaw.plugin.json` still exposes configuration that no longer matches the runtime:

- `auditStorePath`
- `debug.logDir`
- `autoCapture.scope` defaults that reflect an older session-first path
- maintenance-related knobs that are now internal operational details

This creates a misleading install experience. Users see options that are deprecated, removed, or no longer intended as normal user-facing configuration.

### 2. The install script currently feels like the primary setup path

The repo includes `scripts/install.sh` and `scripts/install.mjs`, and current documentation still centers them too much. That conflicts with OpenClaw plugin publishing, where the expected user mental model is:

1. install plugin
2. enable/configure plugin
3. use plugin

The platform should not depend on running arbitrary lifecycle scripts automatically.

### 3. Documentation and manifest are not yet fully aligned

Recent runtime simplifications removed the old audit-first and always-on worker story, but the public configuration surface still reflects older architecture.

## Recommended Approach

### Option A: Manifest-First Published Plugin Surface

This is the recommended approach.

Treat `openclaw.plugin.json` as the authoritative public configuration contract and reduce it to currently supported, user-relevant options only.

Keep install scripts, but reposition them as optional bootstrap helpers rather than the main installation path.

#### Why this is recommended

- Matches OpenClaw plugin publishing expectations
- Minimizes user confusion
- Reduces stale exposed settings
- Keeps the plugin easier to explain on ClawHub
- Follows first principles: fewer exposed knobs, fewer mismatches, less config-driven failure

### Option B: Installer-First

Keep the installer as the main user path and rely on it to smooth over runtime complexity.

This is not recommended because it conflicts with the plugin mental model and depends too much on users running extra setup manually.

### Option C: Dual Package Modes

Create separate “plugin mode” and “installer mode” distribution stories.

This is not recommended because it adds packaging complexity without clear end-to-end recall benefit.

## Design

### 1. Publishing Model

The repository should be positioned primarily as an **OpenClaw memory plugin**.

ClawHub is the distribution channel, not a reason to redesign the package into a script-driven skill.

Primary install path:

- OpenClaw plugin install
- ClawHub install

Secondary path:

- optional bootstrap or developer-oriented setup script

### 2. Public Config Surface

The manifest should expose only the settings that are still meaningful to users.

#### Keep

- `lancedbPath`
- `mem0.mode`
- `mem0.baseUrl`
- `mem0.apiKey`
- `mem0.llm.provider`
- `mem0.llm.baseUrl`
- `mem0.llm.apiKey`
- `mem0.llm.model`
- `outboxDbPath`
- `debug.mode`
- `autoRecall.enabled`
- `autoRecall.topK`
- `autoRecall.maxChars`
- `autoRecall.scope`
- `autoRecall.reranker.provider`
- `autoRecall.reranker.baseUrl`
- `autoRecall.reranker.apiKey`
- `autoRecall.reranker.model`
- `autoCapture.enabled`
- `autoCapture.requireAssistantReply`
- `autoCapture.maxCharsPerMessage`

#### Remove

- `auditStorePath`
- `debug.logDir`
- maintenance internals exposed as normal user config
- stale configuration semantics tied to removed runtime flows

#### Default alignment

- `autoCapture.scope` should default to `long-term`
- `debug.mode` should stay `off`
- `autoRecall.scope` should stay `all`
- `mem0.mode` may remain `local`, but docs must clearly explain the local Mem0 prerequisite

### 3. Install Script Role

`scripts/install.mjs` and `scripts/install.sh` should remain available, but be reframed as:

- optional bootstrap
- local development helper
- convenience config writer

They should not be the canonical user installation path in docs or release messaging.

The generated config defaults from the installer must match the manifest defaults and current runtime defaults.

### 4. Documentation UX

README and release-facing docs should shift to:

1. plugin install first
2. choose Mem0 mode
3. minimal config example
4. optional bootstrap script for convenience

The docs should explicitly distinguish these user profiles:

- local Mem0 users
- remote Mem0 users
- LanceDB-only users (`mem0.mode = disabled`)

### 5. Runtime Consistency

Internal runtime defaults may continue to include operational knobs such as migration or consolidation settings, but these should remain internal unless there is a clear user-facing need.

The public contract should not expose internals just because the runtime happens to have them.

This follows the project’s current design principles:

- avoid over-engineering
- avoid redundant process surfaces
- optimize for end-to-end memory behavior rather than control surface size

## Testing Strategy

Add a lightweight consistency test that ensures the published manifest defaults do not drift away from the runtime defaults for the public surface.

At minimum, verify:

- manifest omits removed fields
- manifest defaults match `resolveConfig()` for user-facing keys
- installer-generated defaults match the same public config expectations

## Success Criteria

- New users no longer see removed fields such as `auditStorePath`
- Plugin install docs do not imply install scripts are mandatory
- Public config surface matches current runtime reality
- ClawHub/plugin publication presents a clean and credible plugin UX
