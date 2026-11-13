# Studio agent

Always-on agent for Artifact Studio. Every comment sent to it is worked **in parallel**
(one worker process per comment), edits are 3-way merged and published as new versions,
then the agent replies on the thread and resolves it.

Provider-agnostic: the worker is any headless coding-agent CLI.

```sh
# pi, any provider/model
STUDIO_AGENT_NAME=Claude STUDIO_AGENT_CMD='["pi","-p","--no-session","--model","anthropic/claude-sonnet-5-5","--tools","read,edit,write","{prompt}"]' node integrations/studio-agent/agent.mjs
# Claude Code
STUDIO_AGENT_NAME=Claude STUDIO_AGENT_CMD='["claude","-p","--permission-mode","acceptEdits","{prompt}"]' node integrations/studio-agent/agent.mjs
# Codex
STUDIO_AGENT_NAME=Codex  STUDIO_AGENT_CMD='["codex","exec","--full-auto","{prompt}"]' node integrations/studio-agent/agent.mjs
```

Several can run at once under different names; `@Name` in a comment picks one.
Token: an API key with `agent:connect artifact:read artifact:create comment:write`
in `~/.artifact-studio/agent-token` (or `STUDIO_AGENT_TOKEN_FILE`).
