---
name: artifact-server
description: Publish, review, organize, and share work with Artifact Server, or operate an installation when the user explicitly requests administrator work. Use for Artifact Server links, files or sites to upload, project, artifact, version, tag, sharing, or comment work, connection help, and explicit install, deploy, upgrade, backup, restore, or repair requests. Do not use for unrelated package publishing or for building software that the user did not ask to store in Artifact Server.
---

# Artifact Server

Use one skill for Artifact Server work. Route the request before loading detailed
instructions.

## Before making any artifact

Read [content guidelines](references/content-guidelines.md) and start from
[the starter](assets/starter.html) (React + Radix + Tailwind, built-in `<Quiz>`).
Artifacts are visual or interactive only; explainers need a tiny quiz every 2–3
sections. `artifactserver publish` refuses pages that break these rules and
prints what to fix: fix them, never pass `--skip-guidelines` unless the user asks.

On this machine the server is the local studio: no sign-in, no API key. Give the
user the `review` link from the publish output.

## Route the request

- For publishing, updating, opening, sharing, commenting, tagging, comparing,
  restoring an artifact version, or managing projects, read
  [artifact operations](references/artifact-operations.md). Read
  [target selection](references/target-selection.md) when the server or project
  is not already exact.
- For an explicit request to install, deploy, upgrade, reconfigure, back up,
  restore, inspect, repair, or delete an Artifact Server installation, read
  [server operations](references/server-operations.md). Do not load or follow
  administrator instructions for routine artifact work.
- Read [failures and compatibility](references/failures-and-compatibility.md)
  only after a failure, incompatibility, authentication problem, or ambiguous
  target.

If a request includes both artifact work and server administration, keep the
steps separate and state which installation is affected before changing it.

## Keep these boundaries

- Use the installed `artifactserver` CLI for files on the user's machine. Use
  the connected Artifact Server MCP for work that needs only server data.
- Never replace a real file with inline HTML, base64, invented bytes, or a local
  path sent to a remote MCP server.
- Never read, print, request in chat, or write bearer tokens, API keys, cookies,
  or refresh tokens.
- Keep public sharing off unless the user explicitly requests it.
- Verify success from structured CLI, MCP, HTTP, or deployment health results.
  Never infer success from a command that merely started.

## Report the result

After publication, give the full-screen review-and-comment link first. Give the
raw immutable artifact link second when it is useful. Include the server,
project ID, artifact ID, and exact version ID in technical details rather than
making the user reconstruct them.
