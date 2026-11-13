#!/usr/bin/env node
/**
 * Studio agent: an always-on, provider-agnostic agent that answers every
 * comment sent to it, all in parallel. Any headless coding-agent CLI works
 * (pi with any provider, claude -p, codex exec, opencode run, ...).
 *
 * - Registers as agent STUDIO_AGENT_NAME and long-polls the dispatch mailbox.
 * - Each claimed dispatch is reported delivered at once, so the next claim is
 *   never blocked: many dispatches (one per comment) run concurrently.
 * - Every thread gets its own headless worker process (STUDIO_AGENT_CMD)
 *   editing a private copy of the artifact's entry file.
 * - Finished copies are folded into the newest version with a 3-way merge
 *   (`git merge-file`), published as one new version per merge, then the
 *   worker's reply is posted. The reviewer resolves the thread, not the agent.
 *
 * Env: ARTIFACT_SERVER_ORIGIN  default http://127.0.0.1:8787
 *      STUDIO_AGENT_TOKEN_FILE file with an API key (agent:connect, artifact:*, comment:write)
 *      STUDIO_AGENT_NAME       display name in the review, e.g. "Claude", "Codex" (default "Agent")
 *      STUDIO_AGENT_KIND       slug shown as metadata (default "studio")
 *      STUDIO_AGENT_CMD        JSON argv; "{prompt}" is replaced by the task text.
 *                              default ["pi","-p","--no-session","--tools","read,edit,write","{prompt}"]
 *      STUDIO_AGENT_CONCURRENCY max parallel workers (default 8)
 */
import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, readFile, writeFile, copyFile} from "node:fs/promises";
import {homedir, tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

const run = promisify(execFile);
const origin = process.env.ARTIFACT_SERVER_ORIGIN ?? "http://127.0.0.1:8787";
const tokenFile = process.env.STUDIO_AGENT_TOKEN_FILE
  ?? join(homedir(), ".artifact-studio", "agent-token");
const agentName = process.env.STUDIO_AGENT_NAME ?? "Agent";
const agentKind = process.env.STUDIO_AGENT_KIND ?? "studio";
const agentCommand = JSON.parse(process.env.STUDIO_AGENT_CMD
  ?? '["pi","-p","--no-session","--tools","read,edit,write","{prompt}"]');
const concurrency = Number(process.env.STUDIO_AGENT_CONCURRENCY ?? 8);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const token = (await readFile(tokenFile, "utf8")).trim();
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);

async function api(path, init = {}) {
  const response = await fetch(origin + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (response.status === 204) return null;
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return text === "" ? null : JSON.parse(text);
}
const post = (path, body, extra = {}) =>
  api(path, {body: JSON.stringify(body), headers: extra, method: "POST"});

// ---------------------------------------------------------------- presence
let agentId = null;
let busy = 0;
async function register() {
  const {agent} = await post("/api/v1/agents", {
    capabilities: {beacon: true, evidence: "native"},
    connectionKey: `studio-agent:${agentName}`,
    displayName: agentName,
    kind: agentKind,
    workingDirectory: repoRoot,
  });
  agentId = agent.id;
  log("registered", agentId);
}
function beacon() {
  if (agentId === null) return;
  post(`/api/v1/agents/${agentId}/activity`, {state: busy > 0 ? "replying" : "idle"})
    .catch(() => undefined);
}

// ---------------------------------------------------------------- lookups
async function locateThread(projectId, threadId) {
  const listed = await api(`/api/v1/artifacts?projectId=${projectId}&limit=100`);
  for (const {artifact} of listed.artifacts) {
    const page = await api(
      `/api/v1/artifacts/${artifact.id}/comments?projectId=${projectId}&dispatched=include&limit=100`,
    );
    if (page.items.some((thread) => thread.id === threadId)) return artifact.id;
  }
  throw new Error(`thread ${threadId} not found`);
}

async function currentEntry(projectId, artifactId) {
  const details = await api(`/api/v1/artifacts/${artifactId}?projectId=${projectId}`);
  const {version} = details.current;
  const entry = version.entryPath;
  const html = await (await fetch(
    `${origin}/api/v1/artifacts/${artifactId}/versions/${version.id}/file?projectId=${projectId}&path=${encodeURIComponent(entry)}`,
    {headers: {Authorization: `Bearer ${token}`}},
  )).text();
  return {entry, html, name: details.artifact.name, versionId: version.id};
}

// ---------------------------------------------------------------- worker
function workerPrompt({body, entry, history, quoted, name}) {
  return [
    `You are ${agentName}, editing the artifact "${name}" in response to one review comment.`,
    `The artifact's file is ./${entry} in the current directory. Edit only that file, in place,`,
    "with minimal targeted edits (keep everything else byte-identical so parallel edits merge).",
    "If the comment is only a question, do not edit; just answer it.",
    quoted ? `The reviewer selected this text: "${quoted.slice(0, 400)}"` : "The comment is on the whole page.",
    `Comment: ${body}`,
    ...(history.length === 0 ? [] : [
      "Conversation so far on this comment (oldest first); answer the LAST message:",
      ...history.map((reply) => `- ${reply.author.principalKind === "service" ? "you" : reply.author.displayName}: ${reply.body.slice(0, 1500)}`),
    ]),
    "",
    "Finish with your reply to the reviewer after a line containing only REPLY:",
    "Keep it to 1-2 sentences saying what you changed. When a picture says it faster (a before/after,",
    "a flow, a structure), add a sketch block under the sentence. Sketch syntax, one edge per line:",
    "```sketch",
    "A[Before: 3-line title] -> B[After: 6 words]!: cut",
    "B -> C(Reads in 2s)",
    "```",
    "[x] = box, (x) = pill, trailing ! = highlight, `: text` labels the arrow. No SVG, no images.",
  ].join("\n");
}

// Bounded parallelism: at most `concurrency` worker processes at once.
let running = 0;
const waiting = [];
async function withSlot(task) {
  if (running >= concurrency) await new Promise((go) => waiting.push(go));
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

async function runWorker(thread, replies, base, name) {
  const dir = await mkdtemp(join(tmpdir(), "studio-agent-"));
  const file = join(dir, basename(base.entry));
  await writeFile(file, base.html);
  const quoted = typeof thread.anchor?.originalText === "string" ? thread.anchor.originalText : null;
  const prompt = workerPrompt({body: thread.body, entry: basename(base.entry), history: replies, name, quoted});
  const [command, ...args] = agentCommand.map((part) => part === "{prompt}" ? prompt : part);
  const {stdout} = await withSlot(() => {
    const pending = run(command, args, {cwd: dir, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000});
    pending.child.stdin?.end(); // headless CLIs (pi -p) wait for stdin EOF otherwise
    return pending;
  });
  // Everything after the last REPLY: line is the reply (text plus optional sketch).
  const at = stdout.lastIndexOf("REPLY:");
  const reply = (at < 0 ? stdout.trim().split("\n").at(-1) : stdout.slice(at + 6).trim()) || "Done.";
  return {edited: await readFile(file, "utf8"), reply: reply.slice(0, 4000)};
}

// ---------------------------------------------------------------- merge + publish
const artifactLocks = new Map();
function withArtifactLock(artifactId, task) {
  const previous = artifactLocks.get(artifactId) ?? Promise.resolve();
  const next = previous.then(task, task);
  artifactLocks.set(artifactId, next.catch(() => undefined));
  return next;
}

/** Fold one worker's copy into the newest version; null on a merge conflict. */
async function mergeAndPublish(projectId, artifactId, base, edited) {
  return withArtifactLock(artifactId, async () => {
    if (edited === base.html) return "unchanged";
    const latest = await currentEntry(projectId, artifactId);
    const dir = await mkdtemp(join(tmpdir(), "studio-merge-"));
    const [ours, baseFile, theirs] = ["ours", "base", "theirs"].map((n) => join(dir, n));
    await Promise.all([writeFile(ours, latest.html), writeFile(baseFile, base.html), writeFile(theirs, edited)]);
    try {
      await run("git", ["merge-file", ours, baseFile, theirs]);
    } catch {
      return null; // overlapping edits: caller retries on the newest version
    }
    const out = join(dir, "publish");
    await mkdir(out);
    const target = join(out, basename(latest.entry));
    await copyFile(ours, target);
    await run("node", [
      "--import", "tsx", "src/cli/main.ts", "publish", target,
      "--server", origin, "--token-file", tokenFile,
      "--project", projectId, "--artifact", artifactId, "--expected-version", latest.versionId,
    ], {cwd: repoRoot, maxBuffer: 8 * 1024 * 1024});
    return "published";
  });
}

async function handleThread(projectId, threadId) {
  const artifactId = await locateThread(projectId, threadId);
  const {replies, thread} = await api(`/api/v1/artifacts/${artifactId}/comments/${threadId}?projectId=${projectId}`);
  if (thread.state !== "open") return;
  // Already answered (threads stay open for the reviewer): don't redo it.
  if (replies.at(-1)?.author.principalKind === "service") return;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const base = await currentEntry(projectId, artifactId);
    log(`thread ${threadId.slice(-6)} -> worker (attempt ${attempt})`);
    const {edited, reply} = await runWorker(thread, replies, base, base.name);
    const outcome = await mergeAndPublish(projectId, artifactId, base, edited);
    if (outcome === null) continue;
    await post(
      `/api/v1/artifacts/${artifactId}/comments/${threadId}/replies?projectId=${projectId}`,
      {body: reply},
      {"Idempotency-Key": `agent-${threadId}-${randomUUID()}`},
    );
    // The reviewer resolves; the agent only replies (Claude Docs model).
    log(`thread ${threadId.slice(-6)} ${outcome}, replied`);
    return;
  }
  await post(
    `/api/v1/artifacts/${artifactId}/comments/${threadId}/replies?projectId=${projectId}`,
    {body: "My edit overlapped with another change at the same spot. Could you resend this comment?"},
    {"Idempotency-Key": `agent-${threadId}-${randomUUID()}`},
  );
}

async function handleDispatch(dispatch) {
  busy += 1;
  beacon();
  try {
    // One worker per thread, all at once.
    await Promise.all(dispatch.threadIds.map((threadId) =>
      handleThread(dispatch.projectId, threadId).catch(async (error) => {
        log("thread failed:", error.message);
        // Never fail silently: the reviewer sees the error on the thread.
        const artifactId = await locateThread(dispatch.projectId, threadId).catch(() => null);
        if (artifactId === null) return;
        await post(
          `/api/v1/artifacts/${artifactId}/comments/${threadId}/replies?projectId=${dispatch.projectId}`,
          {body: `I couldn't finish this one: ${String(error.message).slice(0, 300)}`},
          {"Idempotency-Key": `agent-${threadId}-${randomUUID()}`},
        ).catch(() => undefined);
      })
    ));
  } finally {
    busy -= 1;
    beacon();
  }
}

// ---------------------------------------------------------------- main loop
/**
 * A restart loses in-flight work: dispatches already reported delivered to an
 * earlier run under this name. Pick up every such thread that is still open.
 */
async function adoptOrphans() {
  const {projects} = await api("/api/v1/projects");
  for (const project of projects) {
    const page = await api(`/api/v1/agent-dispatches?projectId=${project.id}&state=delivered&limit=100`);
    for (const dispatch of page.items) {
      if (dispatch.agentDisplayName !== agentName || dispatch.agentId === agentId) continue;
      log(`adopting ${dispatch.id} from a previous run`);
      void handleDispatch(dispatch);
    }
  }
}

await register();
await adoptOrphans().catch((error) => log("adopt:", error.message));
setInterval(beacon, 20_000);
// Leave presence at once on shutdown, so the review never routes to a dead agent.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    post(`/api/v1/agents/${agentId}/disconnect`, {}).finally(() => process.exit(0));
  });
}
let backoff = 1000;
for (;;) {
  try {
    const claimed = await post(`/api/v1/agents/${agentId}/claims?wait=25`, {});
    backoff = 1000;
    if (claimed === null) continue;
    const {dispatch} = claimed;
    log(`dispatch ${dispatch.id} with ${dispatch.threadIds.length} thread(s)`);
    // Delivered at once so the next claim is free: dispatches run in parallel.
    await post(`/api/v1/agent-dispatches/${dispatch.id}/delivered`, {agentId});
    void handleDispatch(dispatch);
  } catch (error) {
    log("claim loop:", error.message);
    if (/40[34]/.test(error.message)) await register().catch(() => undefined);
    await new Promise((done) => setTimeout(done, backoff));
    backoff = Math.min(backoff * 2, 30_000);
  }
}
