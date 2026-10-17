---
name: new-project
description: Start a new project with cimiento through a short conversation, then run cimiento new --json. Use when the person wants to create a new app or website with a repository, hosting and everything wired and deployed.
allowed-tools: Bash(cimiento new:*) Bash(cimiento up:*) Bash(cimiento plan:*) Bash(cimiento doctor:*) Bash(cimiento explain:*) Bash(open:*)
---

# Start a new project with cimiento

Ask these questions one at a time, waiting for each answer:

1. What is the project called? Turn the answer into a short lowercase name with dashes, such as
   `my-shop`, and confirm it.
2. What are they making?
   - A website from a design: `--preset designer` (GitHub and Vercel, with a `design/` folder for
     Claude Design exports).
   - A full app: `--preset fullstack` (GitHub, Vercel, Supabase, Inngest, Turnstile and Anthropic).
3. Which language should cimiento explain things in, English or Spanish? Use `--lang en` or
   `--lang es`.

Then tell the person what will happen in two sentences, and run:

```
cimiento new <name> --preset <designer|fullstack> --lang <en|es> --json --yes
```

Read the output line by line; every line is one json event.

- If the run stops with `BILLING_APPROVAL_NEEDED`, show the warning lines, which name who pays and
  on which plan, and ask whether to approve. Only on a yes, run the same command with
  `--allow-billing` added.
- If it ends with exit code 2, the run is waiting on person steps. The first json line is
  `person-steps` with their titles in order: list them for the person, then take them one at a
  time from the `manual` events:
  - A step with a `step` object is a browser page. Show it as it is: the title, the full link,
    the clicks in order, each field and its value, the button, and what success looks like. Ask
    the person to say when they are ready, run `open "<step.url>"` to open the page, and wait for
    them to say it is done. Then run `cimiento up --json --yes` in the project folder printed in
    the first event; cimiento checks the step and goes on to the next one.
  - A login (an id ending in `.session`) or a secret (an id starting with `vercel.env.`) needs a
    real terminal: the vendor login waits there, and a secret is typed at a hidden prompt. Ask the
    person to run `cimiento up` in their own terminal in the project folder, and to tell you when
    it finishes. Then run `cimiento up --json --yes` to continue.
  - Repeat until the run ends with exit code 0.
- When it ends with exit code 0, give the production URL from the receipts and suggest
  `cimiento doctor` as the way to check the project later.

Never ask for a password, token or API key in the chat. Secrets are typed into cimiento's hidden
prompt in the person's own terminal.
