---
name: explain
description: Explain in plain language what a cimiento resource, step or error code means, in English or Spanish. Use when the person asks what something in a cimiento plan, doctor report or error is, for example vercel.marketplace-terms or SUPABASE_FREE_PROJECT_LIMIT.
allowed-tools: Bash(cimiento explain:*)
---

# Explain a cimiento resource or error

1. Find the key: a resource id such as `inngest.check.roundtrip`, or an error code such as
   `SESSION_LOGIN_FAILED`. If the person describes it in their own words, run `cimiento plan --json`
   or `cimiento doctor --json` in the project folder to find the matching id.
2. Run `cimiento explain <key>`, adding `--lang es` when the person writes in Spanish.
3. Answer with that text, in the person's language, and add the next action from the error's
   hint when there is one. Do not add details the explanation does not contain.
