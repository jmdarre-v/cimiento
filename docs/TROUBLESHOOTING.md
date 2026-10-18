# Troubleshooting

Every error cimiento can report, with what to do about it and why it happens. This file is
generated from the knowledge base in `src/kb` by `node scripts/troubleshooting.mjs`; edit the
yaml, not this file.

Every error carries its code. `cimiento explain <CODE>` prints a plain explanation (in Spanish
with `--lang es`) followed by the same hint and fix, and `cimiento doctor` shows which step
failed. Exit codes: 0 ok, 1 failed, 2 waiting on a person, 3 blocked.

- [cimiento itself](#cimiento-itself)
- [Tools and logins](#tools-and-logins)
- [Secrets](#secrets)
- [Starter templates](#starter-templates)
- [GitHub](#github)
- [Vercel](#vercel)
- [Supabase](#supabase)
- [Inngest](#inngest)
- [Cloudflare Turnstile](#cloudflare-turnstile)
- [Anthropic](#anthropic)

## cimiento itself

### ACCOUNT_CHOICE_NEEDED

Several accounts and none pinned.

**What to do:** Run cimiento accounts set <provider> in a terminal and pick one, or pass --to with the id. The choice is written to stack.yaml, and state follows it.

**Why:** The account decides who owns and who pays for what cimiento creates, so it is never guessed. With exactly one free option cimiento pins it without asking. The Supabase organization question shows each organization with its plan, warns on a paid one, and always offers to create a new organization, named after the project by default.

**Looks like:** `does not say which one this project uses`

### BILLING_APPROVAL_NEEDED

The plan creates billable resources nobody approved.

**What to do:** Approve with --allow-billing, or run cimiento up in a terminal and answer the question.

**Why:** Each billable item gets one warning naming the account or organization it bills to and that account's plan, with an explicit note when the plan is paid. The same database is one item, not two.

**Looks like:** `can cost money`, `bills to`

### CHECK_FAILED

A probe came back negative.

**What to do:** Run cimiento doctor --json to see which item failed, then cimiento explain <resource>.

**Why:** A check proves function, not existence. The message names the thing that could not be proved.

**Looks like:** `did not verify`, `cimiento expects 200`

### DEFERRED_UNRESOLVED

A value that only exists after an earlier step.

**What to do:** Run cimiento up so the earlier step produces the value, then run the command again.

**Why:** The production URL exists only after the first deployment, and the Supabase keys only after the project is created. plan shows these as blocked, which is correct, not an error.

**Looks like:** `needs values that do not exist yet`

### DEV_SERVICE_FAILED

Cimiento dev could not start a local service.

**What to do:** Read the line above it, which names the service. For the local database, Docker Desktop has to be running; cimiento dev opens it on a Mac and waits.

**Why:** cimiento dev runs the local Supabase database on Docker, the Inngest dev server on port 8288 and the app on port 3000. When one stops, it stops the others so nothing is left running in the background.

**Looks like:** `Docker is not running`, `stopped on its own`, `supabase start failed`

### DOWN_CONFIRMATION_NEEDED

Cimiento down needs the project name typed back.

**What to do:** Run cimiento down in a terminal and type the project name when it asks, or pass --yes when you are sure.

**Why:** down deletes real resources in real accounts, so it never runs on a single keypress. --yes skips the question for scripted cleanup such as field tests.

**Looks like:** `type the project name`

### DOWN_LEFTOVER

Down left something it created but cannot delete.

**What to do:** Delete it at the dashboard link down prints, when you no longer need it.

**Why:** The Supabase Management API has no way to delete an organization, so down lists an organization cimiento created as a leftover with its dashboard link, keeps the record in state, and drops it once the organization is gone. The Inngest API cannot delete or archive an app either, so down lists the Inngest app in the run that removes its endpoint.

**Looks like:** `cannot delete organizations`, `cannot delete or archive apps`

### HOSTING_PREVIEW_NOT_READY

A pushed branch has no ready preview yet.

**What to do:** Wait a minute and run cimiento doctor again. If the state says error, open the build log of that preview in the hosting dashboard.

**Why:** The hosting provider builds a preview for every pushed branch by itself. hosting.preview checks that each branch other than production has a ready preview of its latest commit, so a branch whose preview failed to build shows up here instead of in production.

**Looks like:** `No ready preview for`

### JOIN_NO_STATE

There is nothing in this folder to join.

**What to do:** Pull the latest commit of the repository, which carries .cimiento/state.json. If the project was never set up, run cimiento up instead.

**Why:** join connects a new machine to resources that already exist, and state is the list of them. Without it there is nothing to verify; up is the command that creates them.

**Looks like:** `has no .cimiento/state.json`

### MANIFEST_INVALID

Stack.yaml does not pass validation.

**What to do:** Fix every field the message lists, then run cimiento plan again.

**Why:** Compare stack.yaml with docs/SPEC.md section 4. The message names each field and the rule it broke.

**Looks like:** `is not valid`, `Unrecognized key`

### MANIFEST_NOT_FOUND

No stack.yaml in this folder.

**What to do:** Run cimiento init here, or cimiento new <name> to create a project folder.

**Why:** cimiento only manages folders that declare what they need. init writes the declaration without touching your code.

**Looks like:** `No stack.yaml in`

### MANIFEST_UNKNOWN_PROVIDER

A slot names a provider this build does not ship.

**What to do:** Set that slot to none in stack.yaml, or upgrade cimiento.

**Why:** This build ships github, vercel, supabase, inngest, turnstile and anthropic. resend, stripe and posthog arrive in a later release.

**Looks like:** `No provider module named`

### MANUAL_STEP_PENDING

A step only a person can do.

**What to do:** Run cimiento up in a terminal. It opens the page in your browser, waits for Enter, then checks the step really is done.

**Why:** Accepting vendor terms and approving an integration cannot be automated. cimiento opens the page, waits, and proves the result with a probe before it continues. A step that already verifies is never asked for, and a step still waiting is asked once per run, not once per pass.

**Looks like:** `has not been confirmed yet`, `still does not look done`

### PLAN_CYCLE

Two steps wait on each other.

**What to do:** This is a bug in cimiento. Run cimiento plan --json and open an issue with the output.

**Why:** Nothing to do in your project. The dependency graph a provider or wiring rule declares has a loop in it.

**Looks like:** `Dependency cycle`

### PLAN_UNKNOWN_DEPENDENCY

A step waits on something nothing produces.

**What to do:** This is a bug in cimiento. Run cimiento plan --json and open an issue with the output.

**Why:** Nothing to do in your project. A provider declared a dependency on a resource id that is never emitted.

**Looks like:** `which no provider or wiring rule produces`

### STATE_UNREADABLE

The state file is damaged.

**What to do:** Delete the state file and run cimiento plan again.

**Why:** State is rebuilt by adoption. Everything that already exists is found by name and re-recorded, nothing is created twice.

**Looks like:** `Could not read`

### STATE_VERSION_UNSUPPORTED

The state file comes from a newer cimiento.

**What to do:** Upgrade cimiento, or delete the state file and let plan rebuild it.

**Why:** Install the latest cimiento with npm install -g cimiento@latest, then run the same command again.

**Looks like:** `this build understands version`

### TOOL_INSTALL_FAILED

The install command failed.

**What to do:** The installer message in the error says what went wrong. cimiento up retries the install safely.

**Why:** On a fresh Mac the usual cause is that Homebrew itself is missing. Install it from https://brew.sh first.

**Looks like:** `Installing`, `brew: command not found`

### TOOL_MISSING

A required command line tool is not installed.

**What to do:** cimiento up installs the tool for you.

**Why:** macOS installs come from Homebrew for git, gh and supabase, and from npm for the Vercel CLI.

**Looks like:** `command not found`, `is not on PATH`, `ENOENT`

### TOOL_VERSION_TOO_OLD

The tool is installed but too old.

**What to do:** cimiento up upgrades the tool for you with brew upgrade or npm, whichever installed it.

**Why:** Old CLI versions change their json output shape, which is what cimiento reads. The range in the message is the minimum that has been tested. The version in the message is read from that tool itself.

**Looks like:** `cimiento needs >=`

## Tools and logins

### SESSION_ACCOUNT_MISMATCH

Logged in as the wrong account.

**What to do:** Log in as the account stack.yaml pins, or run cimiento accounts set <provider> to pin the account you are logged in as.

**Why:** This is the guard that stops a project being deployed into a personal account when it belongs to a team, or the other way round. It is deliberate, not a bug.

**Looks like:** `but stack.yaml pins`, `cannot reach the team`

### SESSION_LOGIN_FAILED

The browser login did not finish.

**What to do:** Read the cause in the message, which comes from the vendor's own log, and do what the hint says for it; most often that is cimiento up again with the approval given within two minutes.

**Why:** The browser window was closed, or the approval was not given. Retrying is safe. If the message contains a device code link or says Waiting for authentication, or mentions a non TTY environment, the login was run without the terminal attached, which is the Goal 1 Part A bug, fixed by running every login through io.interactive.

**Looks like:** `auth login failed`, `login failed`, `still reports no account`, `Waiting for authentication`, `oauth/device?user_code=`, `Cannot use automatic login flow inside non-TTY`, `Using workdir`, `Invalid authentication scope`, `Timed out waiting for authorization code`

### SESSION_MISSING

Not logged in to the service.

**What to do:** Run cimiento up in a terminal. It opens the vendor login in your browser and waits while you approve it.

**Why:** cimiento never asks for a password or a pasted token. Every login is the vendor browser or device flow, run in the foreground so its code and link are visible. In a --json or agent run with no terminal, cimiento does not start a login nobody can see; it stops with exit code 2 and this step pending.

**Looks like:** `Not logged in to`, `no credentials found`, `You must log in`, `Logged out.`

## Secrets

### SECRET_MISSING

A declared secret has no value.

**What to do:** Run cimiento up or cimiento secret set NAME in a terminal; both ask at a hidden prompt.

**Why:** cimiento prompts with hidden input, pushes the value to every declared sink and keeps no copy. It never asks you to paste a key into a chat window, and it never invents one.

**Looks like:** `has no value for`, `is not set in the`, `No value for`, `cimiento has no value for`

### SECRET_NOT_DECLARED

Stack.yaml does not declare that secret.

**What to do:** Use a name from the secrets section of stack.yaml, or add the secret there first with the sinks it belongs in.

**Why:** A secret exists for a project only when its stack.yaml declares it. A secret only one project needs goes in that project's stack.yaml, never in a preset, and cimiento secret remove NAME takes one out of stack.yaml, the hosting env and the keychain in one step.

**Looks like:** `does not declare a secret named`

### SECRET_SINK_UNAVAILABLE

A secret targets a destination this build cannot write to.

**What to do:** Remove that sink from the secret in stack.yaml, or upgrade cimiento.

**Why:** This build writes to the hosting sink. The database and ci sinks arrive in a later release.

**Looks like:** `only writes to`

### SECRET_SOURCE_UNAVAILABLE

The declared secret source cannot be read right now.

**What to do:** Run cimiento up or cimiento secret set NAME in a terminal. cimiento installs the 1Password CLI, and the keychain or 1Password asks you to unlock it.

**Why:** keychain secrets live under service cimiento, account <project>/<NAME>, written through security -i so the value never reaches a command line. 1password secrets are read with op read and the ref in stack.yaml. Both need an unlocked keychain or vault.

**Looks like:** `Storing`, `1Password CLI (op) is not installed`, `1Password is locked or signed out`

## Starter templates

### SCAFFOLD_TARGET_EXISTS

The target folder is not empty.

**What to do:** Pick another name, or run cimiento init inside the folder you already have.

**Why:** cimiento never writes over existing work. init adds stack.yaml to a project that is already started.

**Looks like:** `already exists and is not empty`

### SCAFFOLD_TEMPLATE_UNKNOWN

No such starter template.

**What to do:** Use scaffold.template nextjs-app, designer-site, or none.

**Why:** nextjs-app is the full app starter, designer-site is a site with a design/ folder for Claude Design exports, and none leaves your own code untouched.

**Looks like:** `No template named`

## GitHub

### GITHUB_PERMISSION_DENIED

The GitHub token lacks a scope.

**What to do:** Only an owner or admin of the repository can do this. cimiento doctor shows which account gh is logged in as.

**Why:** A missing scope is GITHUB_SCOPE_MISSING, which cimiento fixes itself. This code means the account itself lacks the right.

**Looks like:** `Must have admin rights`, `delete_repo`, `HTTP 403`

**More:** <https://cli.github.com/manual/gh_auth_refresh>

### GITHUB_REPO_CREATE_FAILED

Gh repo create failed.

**What to do:** cimiento doctor shows which account gh is logged in as and whether it can create repositories.

**Why:** For an organization, an owner may have to approve repository creation. A personal account needs the repo scope, which the cimiento login asks for.

**Looks like:** `gh repo create`, `GraphQL: Resource not accessible`, `Author identity unknown`, `first commit of the scaffold failed`

**More:** <https://cli.github.com/manual/gh_repo_create>

### GITHUB_REPO_NAME_TAKEN

The repository name is already in use.

**What to do:** Pick a different name in stack.yaml, or log in as the owner of the existing repository.

**Why:** cimiento adopts a repository it can see. A name that is taken but invisible means it belongs to another account.

**Looks like:** `already exists`, `name already`

### GITHUB_REPO_NOT_FOUND

The repository is not visible to this account.

**What to do:** cimiento doctor shows which account gh is logged in as. A private repository in another account looks the same as one that does not exist.

**Why:** A private repository in another account looks identical to one that does not exist. Check accounts.github in stack.yaml against gh auth status.

**Looks like:** `No repository`, `Could not resolve to a Repository`, `has no default branch`

### GITHUB_SCOPE_MISSING

The GitHub login lacks the delete_repo permission.

**What to do:** Run cimiento down in a terminal. It asks GitHub for the permission in your browser, then deletes the repository.

**Why:** gh never requests delete_repo at login. cimiento runs gh auth refresh with that scope in the foreground when a person is there, and waits on them otherwise.

**Looks like:** `delete_repo`, `needs the delete_repo permission`

## Vercel

### SUPABASE_CONFIGURATION_CHOICE_NEEDED

A Supabase Marketplace configuration on the team already serves other projects.

**What to do:** Run cimiento up in a terminal. Before the plan it shows the configuration with the databases and projects it serves, and asks whether to reuse it or create the database directly in the organization stack.yaml pins.

**Why:** vercel integration add supabase takes the first Marketplace configuration on the team without asking, so a new database lands in that configuration's Vercel-managed organization whatever stack.yaml pins. Reusing it is recorded as options.supabase.marketplace_configuration; choosing the direct path sets accounts.supabase to direct. Either way down deletes only the database cimiento created, through its Marketplace resource, and never uninstalls a configuration.

**Looks like:** `vercel integration add would put the`

### VERCEL_API_ERROR

Vercel returned an unexpected error.

**What to do:** Read the Vercel message in the error, then run cimiento doctor --json.

**Why:** A 403 almost always means the login belongs to a different team than accounts.vercel in stack.yaml.

**Looks like:** `Vercel answered`

### VERCEL_DEPLOY_FAILED

The deployment did not finish.

**What to do:** Open the build log the message links to.

**Why:** A failing build is almost always an application error. Run the build locally first with pnpm build.

**Looks like:** `vercel deploy --prod failed`, `Build failed`

### VERCEL_DEPLOYMENT_NOT_READY

No ready production deployment.

**What to do:** Wait for the build to finish, then run cimiento doctor again.

**Why:** A first build on a cold project can take a couple of minutes. doctor is safe to run repeatedly.

**Looks like:** `No production deployment exists`, `is BUILDING`, `is QUEUED`

### VERCEL_ENV_WRITE_FAILED

Writing an environment variable failed.

**What to do:** Run cimiento secret set NAME again, or add it by hand in the Vercel project settings.

**Why:** Only the name is ever printed. The value is masked in every log line and in json output.

**Looks like:** `Writing`, `to the production environment of the Vercel project failed`

### VERCEL_GIT_LINK_FAILED

The project is not connected to the repository.

**What to do:** Vercel's GitHub app cannot see this repository yet. Give it access at https://github.com/apps/vercel, then cimiento up continues.

**Why:** Vercel can only connect to repositories its GitHub app can see. On a personal account the app often has access to selected repositories only.

**Looks like:** `Linking the Vercel project`, `points at no repository`, `To link a GitHub repository`

**More:** <https://vercel.com/docs/deployments/git>

### VERCEL_GITHUB_ACCESS_NEEDED

Vercel cannot see the private repository yet.

**What to do:** Run cimiento up in a terminal. It opens the page for what is missing, explains both requirements with their links, and waits for Enter.

**Why:** Linking a private repository needs a GitHub Login Connection on the Vercel account and the Vercel GitHub app installed with access to that repository. cimiento checks both before trying, through the endpoints the Vercel import screen uses, asks for whatever is missing in one person step, recommends Only select repositories with this repository added, then verifies and continues.

**Looks like:** `cannot link`, `install the GitHub integration first`

### VERCEL_GITHUB_CONNECTION_NEEDED

The Vercel account has no GitHub Login Connection.

**What to do:** Connect GitHub under Login Connections at https://vercel.com/account/authentication, then run cimiento up again.

**Why:** Linking a Vercel project to a repository goes through the person's own GitHub connection on Vercel, separate from the Vercel GitHub app. It is a one time browser step per Vercel account.

**Looks like:** `add a Login Connection to your GitHub account`

### VERCEL_MARKETPLACE_TERMS_PENDING

The Marketplace terms have not been accepted.

**What to do:** Run cimiento up in a terminal. It opens the Supabase page of the Vercel Marketplace and waits while you install it.

**Why:** Once per Vercel team. cimiento opens the page, waits for Enter, then proves the step by finding the Supabase integration installed on the team, instead of taking the person's word for it.

**Looks like:** `marketplace`, `terms`, `must accept`

### VERCEL_PLAN_REQUIRED

This needs a paid Vercel plan.

**What to do:** Set options.vercel.plan to hobby in stack.yaml, or upgrade the account.

**Why:** Team projects and the stricter deployment protection settings are paid features.

**Looks like:** `requires a Pro plan`, `not available on the Hobby plan`

### VERCEL_PROJECT_CREATE_FAILED

Vercel refused to create the project.

**What to do:** Pick another name in stack.yaml, or check accounts.vercel points at a team you belong to.

**Why:** Project names are unique per team. cimiento adopts a project it can see, so a name that is taken but invisible belongs to another team.

**Looks like:** `Creating the Vercel project`, `A project with the provided name already exists`

### VERCEL_PROJECT_NOT_FOUND

No Vercel project with this name.

**What to do:** Run cimiento up to create it, or fix accounts.vercel in stack.yaml.

**Why:** With no accounts.vercel, cimiento looks in your personal scope. A project that lives in a team is invisible from there.

**Looks like:** `No Vercel project named`

### VERCEL_TOKEN_MISSING

No Vercel token for the API.

**What to do:** cimiento up opens the Vercel login in your browser. On a machine with no browser, set VERCEL_TOKEN in the environment.

**Why:** cimiento reads the token the Vercel CLI stores after a browser login. It never asks you to paste one into chat.

**Looks like:** `could not find a Vercel token`

## Supabase

### SUPABASE_ADOPTION_CONFIRMATION_NEEDED

The hosting env points at a database older than the project.

**What to do:** Run cimiento up in a terminal and answer yes only if that database belongs to this project. Otherwise disconnect it from the hosting project and cimiento creates a new one.

**Why:** Adopting a database lets cimiento change its Auth URLs, and it used to let down delete it. An older database found through the hosting env now needs a person's yes, adopted resources are recorded with origin adopted in state, and down never deletes an adopted resource.

**Looks like:** `does not adopt an older database`

### SUPABASE_API_ERROR

Supabase returned an unexpected error.

**What to do:** Read the Supabase message in the error, then run cimiento doctor --json.

**Why:** A free tier project pauses after a week without traffic. Restore it from the dashboard before running up again.

**Looks like:** `Supabase answered`, `is INACTIVE`, `is PAUSED`

### SUPABASE_AUTH_URL_FAILED

The Supabase Site URL does not match production.

**What to do:** Run cimiento up to set it, or set it by hand under Authentication, URL Configuration.

**Why:** When the Site URL drifts from the production URL, sign in links and password resets send real users to the wrong address, and nothing in the application logs an error.

**Looks like:** `Supabase Site URL is`, `Setting the Supabase Site URL`

### SUPABASE_DUPLICATE_REFUSED

The hosting env already points at a database this login cannot see.

**What to do:** Run cimiento up in a terminal. It asks you to give this Supabase login access to the organization that holds the database, then adopts it.

**Why:** The database a project uses is the one its hosting env points at. cimiento reads the ref from SUPABASE_URL in the Vercel env, adopts that database whatever its name, and while the env points at a database it cannot see, it plans needs-human instead of create. It never creates a second database.

**Looks like:** `will not create a second database`

### SUPABASE_FREE_PROJECT_LIMIT

The person already has two active free Supabase projects.

**What to do:** Free a slot by pausing or deleting a project in the Supabase dashboard, or run cimiento accounts set supabase and pick a paid-plan or new organization, then run cimiento up again.

**Why:** The limit is two active free projects per person, counted across every organization they own or administer, not per organization. In a terminal cimiento lists the projects that count with their last API request, and offers two choices, freeing a slot in the dashboard or using a paid-plan or new organization, then checks again on Enter and continues. cimiento never pauses or deletes a project it did not create. Without a terminal it stops with exit code 2 and the same list.

**Looks like:** `maximum limits for the number of active free projects`

### SUPABASE_KEYS_MISSING

The Supabase keys never reached the hosting environment.

**What to do:** Run cimiento up, which installs the Supabase integration from the Vercel Marketplace.

**Why:** On the via-hosting path the keys arrive by themselves after the integration is installed. If they do not, switch accounts.supabase to direct and let cimiento push them.

**Looks like:** `No Supabase URL or key is present`

### SUPABASE_MIGRATION_FAILED

The migrations did not apply.

**What to do:** cimiento up applies the migrations again and shows the message Postgres gives back.

**Why:** The message comes from Postgres, not from cimiento. The usual causes are a syntax error in a migration file or a migration that assumes a table an earlier one never created. cimiento applies migrations through the Management API, which records each one by name, so no database password is needed.

**Looks like:** `supabase db push failed`, `supabase link`, `could not read the migration history`

### SUPABASE_ORG_MISSING

Cimiento cannot pick a Supabase organization.

**What to do:** Set options.supabase.organization_id in stack.yaml to the organization you want.

**Why:** With exactly one organization cimiento uses it. With none or several it refuses to guess, because the choice decides who pays.

**Looks like:** `has no organization`, `organizations, so cimiento cannot pick`

### SUPABASE_PROJECT_CREATE_FAILED

Supabase refused to create the project.

**What to do:** The Supabase message in the error says why. cimiento up retries safely once that is fixed.

**Why:** The free project limit has its own code, SUPABASE_FREE_PROJECT_LIMIT. This one covers every other refusal.

**Looks like:** `Creating the Supabase project`, `free plan`, `project limit`

### SUPABASE_PROJECT_NOT_FOUND

No Supabase project with this name.

**What to do:** On the direct path run cimiento up. On the via-hosting path finish the Vercel Marketplace step first.

**Why:** With accounts.supabase set to via-hosting, the Vercel Marketplace creates the project and names it after the Vercel project. If the names differ, set accounts.supabase to direct.

**Looks like:** `No Supabase project named`, `no Supabase project named`

### SUPABASE_TOKEN_MISSING

No Supabase access token for the API.

**What to do:** cimiento up opens the Supabase login in your browser. On a machine with no browser, set SUPABASE_ACCESS_TOKEN in the environment.

**Why:** Supabase CLI v2 keeps its login in the macOS Keychain, service Supabase CLI, account supabase. cimiento reads it from there, then from the old token file, then from the environment. It never asks you to paste a token into chat.

**Looks like:** `could not find a Supabase access token`, `found no Supabase login`

## Inngest

### INNGEST_ENDPOINT_UNREACHABLE

Inngest cannot reach /api/inngest on the production address.

**What to do:** Keep options.vercel.deployment_protection at standard, which leaves production public, and keep app/api/inngest/route.ts in the app. Then run cimiento up.

**Why:** Inngest calls the app at its production address. Standard protection on Vercel guards previews only, so production stays reachable; stricter protection blocks Inngest unless a bypass is configured, which v1 does not do.

**Looks like:** `deployment protection is keeping Inngest out`, `/api/inngest answered`

### INNGEST_KEYS_MISSING

The Inngest keys are not where the app reads them.

**What to do:** Run cimiento up in a terminal. It checks the Inngest integration, asks you to approve it if needed, and deploys again once the keys are in the env.

**Why:** The Inngest Vercel integration puts INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY into the project. A deployment built before that has neither, and up deploys again whenever the env is newer than the live deployment.

**Looks like:** `could not read INNGEST_EVENT_KEY`, `is live but reports`

### INNGEST_ROUNDTRIP_FAILED

An event reached Inngest but no run completed.

**What to do:** Run cimiento up, which registers the app with Inngest again, then cimiento doctor to repeat the check.

**Why:** jobs.roundtrip sends cimiento/roundtrip with the event key, waits for the cimiento-roundtrip function to run, and asks the Inngest API with the signing key for the run status. The app must be synced in Inngest with that function, which the scaffold ships.

**Looks like:** `no run completed within`, `did not accept the cimiento/roundtrip event`, `ended Failed`

## Cloudflare Turnstile

### TURNSTILE_API_ERROR

The Cloudflare API refused a Turnstile request.

**What to do:** Run cimiento up again; it retries safely and finds the widget by name. The message carries the Cloudflare error.

**Why:** cimiento reads its Cloudflare token from the wrangler login, so a refused call is usually a missing permission (cimiento up logs in again asking for it) or a Cloudflare outage. A widget whose domains miss the production host is updated by up.

**Looks like:** `Cloudflare answered`, `does not allow`

### TURNSTILE_SECRET_REJECTED

Siteverify does not accept the secret key.

**What to do:** Run cimiento up. It reads the widget again and rewrites the keys, then cimiento doctor repeats the check.

**Why:** bot_protection.verify sends a dummy token with the secret key. Cloudflare answers invalid-input-response for a good key and invalid-input-secret for a bad one, so only a live key passes.

**Looks like:** `did not accept the secret key`, `could not read the secret key`

### TURNSTILE_WIDGET_NOT_FOUND

The Turnstile widget of this project is gone.

**What to do:** Run cimiento up. It creates the widget again and rewrites both keys in the hosting env.

**Why:** The widget is found by the sitekey in state, or by the project slug as its name. A widget deleted in the Cloudflare dashboard is created again; the old keys stop working, which is why up rewrites them.

**Looks like:** `No Turnstile widget named`

## Anthropic

### ANTHROPIC_API_ERROR

The Anthropic API answered with an error that is not about the key.

**What to do:** Run cimiento doctor again. A billing error needs credit added in the Anthropic Console first.

**Why:** Anything but a 401 or 403 is either billing (402, add credit) or the service itself (429 or 5xx, retry later). The key is fine in both cases.

**Looks like:** `to a read only call`

### ANTHROPIC_KEY_INVALID

The Anthropic API refused the key.

**What to do:** Create a new key in the Anthropic Console, then run cimiento secret rotate ANTHROPIC_API_KEY in a terminal.

**Why:** The check calls GET /v1/models, which is read only and free. A 401 means the key is wrong or revoked; rotate replaces it in the keychain and in every hosting environment at once, and up deploys again so the app reads it.

**Looks like:** `api.anthropic.com refused`, `authentication_error`
