# Chat-First Model Loading Design

**Date:** 2026-07-27

## Goal

Let a user begin by writing a prompt. The first submission loads Gemma on the
device and sends the preserved prompt as soon as the model is ready.

## Interaction

- The composer and seed prompts are enabled before the model is loaded.
- Sending the first prompt begins model loading through the existing
  memory-safe lifecycle.
- The submitted prompt remains visible in the composer while loading.
- A second submission cannot start while loading.
- After warmup succeeds, the original prompt is submitted exactly once.
- If loading fails or another tab owns the model, the prompt remains available
  and the Send control becomes a retry action.
- Later prompts use the existing generation path without another load.

## Manual Controls

Manual Load and Unload controls are hidden by default. A compact Settings
popover in the header contains a `Show manual model controls` toggle. The
preference is stored in local storage for this origin.

When enabled, the existing controls appear in the header and retain their
current behavior. Disabling the preference only hides the controls; it does not
dispose a loaded model or interrupt active work.

## Visual Design

Settings uses an icon-only gear button with an accessible label and tooltip.
The popover uses the app's existing dark surface, border, typography, spacing,
and focus treatment. It contains one concise row with a native-style switch.
The panel is anchored to the header, fits the iPhone viewport, closes on outside
click or Escape, and does not shift the chat layout.

Loading feedback continues to use the existing status bar and progress
indicator. The Send button is disabled during loading and generation, so no new
temporary controls or duplicate spinners are introduced.

## State Flow

`send()` becomes the single submission coordinator:

1. Read and retain the current prompt.
2. If no model exists, call the existing `loadModel()` operation.
3. Stop if loading is blocked or fails, leaving the prompt untouched.
4. On success, pass the retained prompt to generation.
5. Clear the composer only when generation actually begins.

Seed prompts populate the composer and invoke this same coordinator.

## Failure Handling

- Ownership failure leaves the prompt intact and identifies the other tab.
- Loader failure leaves the prompt intact and permits a later retry.
- Reload disposal and origin-wide model ownership remain unchanged.
- Repeated clicks, Enter presses, and seed selections share one in-flight
  submission and cannot load or send twice.

## Tests

- First submission loads and then generates once with the original prompt.
- A load failure preserves the prompt and enables retry.
- Repeated submission while loading does not duplicate loading or generation.
- Seed prompts use the same lazy-load path.
- Manual controls are hidden by default and follow the persisted setting.
- Existing ownership, disposal, reload, TLS, and runtime tests remain green.
