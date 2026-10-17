---
name: secrets
description: Keep API keys, tokens and passwords out of the chat. Use whenever the person pastes or offers a secret value, asks where to put a key, or asks to see a value from .env files.
---

# Secrets never go through the chat

cimiento keeps secret values in the macOS keychain or 1Password and in the hosting env store. They
never appear in `stack.yaml`, state, logs, `--json` output or a chat window.

If the person pastes something that looks like a key, token or password:

1. Do not use it, do not repeat it, do not write it to any file and do not pass it to any command.
2. Tell them, in one sentence, that a value pasted into a chat should be treated as exposed, and
   that they should create a new one where it was issued and revoke the old one.
3. Ask them to run, in their own terminal in the project folder:
   - `cimiento secret set NAME` for a value cimiento does not have yet, or
   - `cimiento secret rotate NAME` to replace one it already has.
   cimiento asks for the value at a hidden prompt and pushes it to every place stack.yaml declares.

If the person asks where a key goes, find the name in the `secrets` section of `stack.yaml`, and
point them to `cimiento secret set NAME`. If the name is not declared, it belongs to this project
alone: add it to `stack.yaml` under `secrets` with the sinks it needs, then `cimiento secret set NAME`.

If the person asks to see values, run `cimiento env print --json`, which shows names and
non-secret outputs only. Never read `.env` files; the plugin blocks it, and the project's
`.claude/settings.json` denies it too.
