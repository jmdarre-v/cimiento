---
name: setup
description: Check and repair the environment of a cimiento project. Runs cimiento doctor --json, fixes only the items that failed, and asks the person one question at a time. Use when something in the project stopped working, after cloning a project, or when the person asks whether everything is set up.
allowed-tools: Bash(cimiento doctor:*) Bash(cimiento plan:*) Bash(cimiento explain:*) Bash(cimiento env print:*)
---

# Set up or repair a cimiento project

The project folder has a `stack.yaml`. cimiento owns the environment; you never change a cloud
dashboard by hand and never edit `.cimiento/state.json`.

1. Run `cimiento doctor --json` in the project folder. Read `items`, `summary` and `outdated`.
2. If every item is ok, say so in one sentence, mention any outdated tools from `outdated`, and stop.
3. Take the failed items in the order doctor lists them. For each one:
   - Read `error.code`, `error.message` and `error.hint`. When the person would not understand the
     message, run `cimiento explain <code> --lang <their language>` and use its words.
   - If `error.personStep` is present, it is a step only a person can do in a browser. Show the
     step as it is: the full link, the clicks in order, each field and its value, the button, and
     what success looks like. Then ask the person to run `cimiento up` in their own terminal,
     where cimiento opens the page after they press Enter and checks the result.
   - If the hint names a cimiento command that changes things (`cimiento up`, `cimiento join`,
     `cimiento accounts set <provider>`), ask the person one yes or no question before running it,
     and run it with `--json` when they say yes. Never pass `--allow-billing` unless the person
     said yes to the billing line cimiento printed, naming who pays.
   - If the hint says `cimiento secret set NAME`, never ask for the value in the chat. Ask the
     person to run that command in their own terminal, where the value is typed at a hidden prompt.
4. Ask one question at a time and wait for the answer before the next one.
5. When the failed items are handled, run `cimiento doctor --json` again and report what is ok now
   and what still waits on the person.

Exit codes: 0 ok, 1 failed, 2 waiting on a person, 3 blocked. Exit 2 is not an error; it means
the next step is the person's.
