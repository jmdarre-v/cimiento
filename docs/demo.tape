# The README demo: a key changed by hand, doctor --smoke finds it, secret set fixes it.
# Run from the repository root with CIMIENTO_CLI, DEMO_DIR and DEMO_TOKEN_FILE set:
# CIMIENTO_CLI points at dist/cli.js, DEMO_DIR at a project made with cimiento new that declares
# DEMO_TOKEN with source env, and DEMO_TOKEN_FILE at a file holding its value. The value is read
# in a hidden step and never typed or shown. Only the lines that matter are shown, so no account,
# team, project or installation id reaches the recording.

Output docs/demo.gif
Require vercel

Set Shell "bash"
Set FontSize 14
Set Width 1400
Set Height 460
Set Padding 18
Set TypingSpeed 30ms
Set WaitTimeout 300s
Set WaitPattern /\$\s*$/

Hide
Type `export PS1='$ ' DEMO_TOKEN="$(cat "$DEMO_TOKEN_FILE")" && alias cimiento="node $CIMIENTO_CLI" && cd "$DEMO_DIR" && clear`
Enter
Wait
Show

Type `cimiento doctor --smoke | grep " ok, "`
Enter
Wait
Sleep 2s

Type "vercel env add DEMO_TOKEN production --value wrong-value --force --yes > /dev/null 2>&1"
Enter
Wait
Sleep 1s

Type `cimiento doctor --smoke | grep -A2 -E " ok, |SECRET_VALUE_MISMATCH"`
Enter
Wait
Sleep 6s

Type "cimiento secret set DEMO_TOKEN 2> /dev/null"
Enter
Wait
Sleep 3s

Type `cimiento doctor --smoke | grep " ok, "`
Enter
Wait
Sleep 4s
