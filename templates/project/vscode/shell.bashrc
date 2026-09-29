# The recording terminal's shell. `ghostcast vscode` points VS Code's terminal at this file (bash
# --rcfile), so nothing personal loads: no ~/.bashrc, no history, no custom prompt, no aliases.
unset PROMPT_COMMAND
export HISTFILE=/dev/null
# h.run and h.prompt wait for a bare `$` as the last row; change project scenes too if you change it.
export PS1='$ '
export GIT_PAGER=cat PAGER=cat

# If VS Code was started from inside an agent session (Claude Code, Codex, ...), the terminal
# inherits that session's variables. An agent CLI run on camera should start clean, on its own login.
for v in $(compgen -e | grep -E '^(CLAUDE|ANTHROPIC|OPENAI|CODEX)'); do unset "$v"; done
export CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=true

# Keys the demo needs, kept off screen: put `export NAME=value` lines in vscode/secrets.env
# (git-ignored). Never `cat` or `echo` them in a take.
[ -f "$(dirname "${BASH_SOURCE[0]}")/secrets.env" ] && . "$(dirname "${BASH_SOURCE[0]}")/secrets.env"

# Quick shoots record the shell's status off camera after each prompt.
if [ -n "${GHOSTCAST_SHOOT_STATUS_FILE:-}" ]; then
  PROMPT_COMMAND='printf "%s\n" "$?" > "$GHOSTCAST_SHOOT_STATUS_FILE"'
fi

# Project-specific setup goes below: PATH to the tool being demonstrated, its config, wrappers.
