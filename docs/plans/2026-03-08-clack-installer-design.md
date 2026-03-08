# Design: Unified Node Installer with @clack/prompts

Date: 2026-03-08

## Problem

The current installation flow is implemented in two shell scripts:

- `scripts/install.sh`
- `scripts/install_zh.sh`

They duplicate nearly all logic and differ mostly in prompt text. This duplication has already caused control-flow drift and subtle bugs, including configuration write failures caused by shell return-code handling under `set -e`.

The plugin now has a larger configuration surface:

- Mem0 mode
- auto recall
- auto capture
- embedding migration
- debug mode and optional file log directory

The shell implementation is becoming increasingly fragile for interactive installation and config merging.

## Goal

Replace the duplicated interactive shell installers with a single Node-based installer that uses `@clack/prompts` for interactive UX, while keeping the two shell entrypoints as thin language-specific wrappers.

## Scope

**Changed:**
- add a unified Node installer
- convert both shell scripts into thin wrappers
- centralize config merge logic
- add tests for installer behavior and wrapper forwarding

**Unchanged:**
- plugin runtime behavior
- plugin config schema
- install command names (`install.sh`, `install_zh.sh`)

## Recommended Architecture

### New primary installer

Add:

- `scripts/install.mjs`

This file becomes the only place that contains:

- argument parsing
- dependency install/build steps
- symlink setup
- OpenClaw config detection
- interactive prompts
- final JSON config merge/write

### Keep shell entrypoints

Retain:

- `scripts/install.sh`
- `scripts/install_zh.sh`

But reduce them to wrappers:

- `install.sh` → `node scripts/install.mjs --lang en "$@"`
- `install_zh.sh` → `node scripts/install.mjs --lang zh "$@"`

This keeps the user-facing commands stable while removing logic duplication.

## Why This Approach

### Option A: Single Node installer + thin shell wrappers

This is the recommended option.

Pros:
- one source of truth for installer logic
- consistent behavior across languages
- easier testability
- safer config merging than shell JSON heredocs
- better interactive UX with `@clack/prompts`

Cons:
- introduces a new runtime dependency for installation UX

### Option B: Two separate Node installers

Pros:
- language text separated more directly

Cons:
- duplicates logic again
- drifts over time
- defeats the primary goal

### Option C: Keep shell scripts and embed Node only for prompts

Pros:
- smaller-looking diff

Cons:
- still mixes control flow across shell and Node
- still hard to test
- fragile state passing

## CLI Contract

The Node installer should support:

- `--yes`, `-y`
- `--skip-config`
- `--help`, `-h`
- `--lang en|zh`

### Behavior

- `--yes`: skip interactive prompts and use defaults
- `--skip-config`: do not modify `openclaw.json`
- `--lang`: choose all user-facing strings

The shell wrappers should only set the language and forward all other arguments unchanged.

## Installer Flow

1. Detect fresh install vs upgrade
2. Confirm install unless `--yes`
3. Run `npm install`
4. Run build (`npm run build`)
5. Ensure plugin symlink exists in OpenClaw extension directory
6. If not `--skip-config`, load `openclaw.json`
7. Ask interactive questions using `@clack/prompts`
8. Build plugin config object
9. Merge plugin config into `openclaw.json`
10. Write file back
11. Print completion summary

## Prompt Surface

The unified installer should ask for:

- Mem0 mode
- Mem0 URL / API key when relevant
- auto recall enabled, topK, maxChars, scope
- auto capture enabled, scope, requireAssistantReply, maxCharsPerMessage
- debug mode
- optional debug log directory when `verbose + file` is chosen

These prompts should be language-driven via a translation dictionary, not duplicated in separate files.

## Config Merge Strategy

The installer should construct a single plugin config object in memory and merge it into:

***REMOVED***
plugins.entries["openclaw-mem0-lancedb"].config
***REMOVED***

It should also ensure:

- plugin allow list contains `openclaw-mem0-lancedb`
- plugin load path contains the plugin directory
- memory slot points to `openclaw-mem0-lancedb`

All merging should happen in Node with explicit object manipulation, not shell-generated JSON fragments.

## Suggested Internal Structure

Inside `scripts/install.mjs`, keep logic modular:

- `parseArgs(argv)`
- `loadStrings(lang)`
- `runCommand(cmd, args, opts)`
- `detectEmbeddingProvider(openclawConfig)`
- `collectAnswers(args, lang, currentConfig)`
- `buildPluginConfig(answers, env)`
- `mergeOpenClawConfig(openclawConfig, pluginConfig, pluginDir, pluginName)`
- `writeOpenClawConfig(path, data)`

This keeps testing focused and avoids a giant monolithic script.

## Internationalization

Use one in-memory strings object, for example:

***REMOVED***js
const STRINGS = {
  en: { ... },
  zh: { ... },
};
***REMOVED***

All prompts, labels, warnings, and summaries should flow through this dictionary.

This preserves language support without duplicating logic.

## Testing Strategy

### Wrapper tests

Keep lightweight tests that verify:

- `install.sh` invokes the Node installer with `--lang en`
- `install_zh.sh` invokes the Node installer with `--lang zh`

### Installer tests

Add focused tests for the Node installer:

- `--yes` default path
- `--skip-config`
- config merge into `openclaw.json`
- writing `debug` config
- writing `mem0` config
- selecting non-default options

The critical improvement is that the real installation logic should be tested directly in Node, not indirectly only through shell interaction.

## Dependencies

Add:

- `@clack/prompts`

Optionally:

- `kleur` if needed by `@clack/prompts` usage patterns, but only if required

Keep dependencies minimal.

## Non-Goals

The first version does not include:

- GUI installer
- remote fetching of templates
- dynamic locale files on disk
- migration of unrelated OpenClaw settings

## Summary

The best solution is to move installation into a single Node-based installer using `@clack/prompts`, with the existing shell scripts reduced to thin language wrappers. This removes duplicated logic, fixes the control-flow fragility of the shell implementation, and makes future config growth manageable.
