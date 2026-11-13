#!/usr/bin/env node
/* oxlint-disable no-await-in-loop -- the claim loop and listings are sequential by design */
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
 * Fully local: it uses the server's own local credential, no API key.
 * Env: ARTIFACT_SERVER_ORIGIN  default http://127.0.0.1:8787
 *      STUDIO_AGENT_NAME       display name in the review, e.g. "Copilot", "Claude" (default "Agent")
 *      STUDIO_AGENT_KIND       slug shown as metadata (default "studio")
 *      STUDIO_AGENT_CMD        JSON argv for the worker CLI. The task is written to TASK.md in the
 *                              worker's folder; "{prompt}" becomes a fixed line telling it to read it.
 *                              default ["pi","-p","--no-session","--tools","read,edit,write","{prompt}"]
 *      STUDIO_AGENT_CONCURRENCY max parallel workers (default 8)
 */
import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, readFile, rm, writeFile, copyFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

const execFileAsync = promisify(execFile);
// Background only: never open a console window. Windows CLIs (copilot, pi) are
// .cmd shims that need a shell; every argument we pass is a fixed string, never
// comment text, so nothing untrusted reaches that shell.
const run = (command, args, options = {}) =>
  execFileAsync(command, args, {...options, shell: process.platform === "win32", windowsHide: true});
const origin = process.env.ARTIFACT_SERVER_ORIGIN ?? "http://127.0.0.1:8787";
// The local server's own credential: no API key, nothing to configure.
const tokenFile = join(dirname(fileURLToPath(import.meta.url)), "../../.artifact-server/local-api-token");
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
    `The artifact's file is ./${entry} in the current directory. Edit only that file, in place`,
    "(never edit TASK.md, never run shell commands),",
    "with minimal targeted edits (keep everything else byte-identical so parallel edits merge).",
    "If the comment is only a question, do not edit; just answer it.",
    "House rules for the page: visual or interactive only (diagrams, charts, widgets, cards), no",
    "paragraph over 60 words, and explainers keep a tiny quiz (data-quiz) every 2-3 sections.",
    "When asked to explain or clarify, prefer a visual or a quiz over more text.",
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

// Every live worker, so shutdown and timeouts never leave orphans behind.
const workers = new Set();
function killTree(child) {
  if (child.exitCode !== null && child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], {windowsHide: true}, () => undefined);
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
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

/** Run `task` in a fresh temp folder that is always deleted afterwards. */
async function inTempDir(prefix, task) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await task(dir);
  } finally {
    await rm(dir, {force: true, recursive: true}).catch(() => undefined);
  }
}

function runWorker(thread, replies, base, name) {
  return inTempDir("studio-agent-", (dir) => runWorkerIn(dir, thread, replies, base, name));
}

async function runWorkerIn(dir, thread, replies, base, name) {
  const file = join(dir, basename(base.entry));
  await writeFile(file, base.html);
  const quoted = String(thread.anchor?.originalText ?? "") || null;
  // Untrusted comment text goes in a file, never on a command line.
  await writeFile(join(dir, "TASK.md"), workerPrompt({body: thread.body, entry: basename(base.entry), history: replies, name, quoted}));
  const launch = "Read ./TASK.md in the current directory and do exactly what it says.";
  const [command, ...args] = agentCommand.map((part) => part === "{prompt}" ? launch : part);
  const {stdout} = await withSlot(() => {
    // Own process group (POSIX), so a timeout or shutdown kills the worker's
    // whole tree, not just the top process.
    const pending = run(command, args, {
      cwd: dir,
      detached: process.platform !== "win32",
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    pending.child.stdin?.end(); // headless CLIs (pi -p) wait for stdin EOF otherwise
    workers.add(pending.child);
    return pending.finally(() => {
      killTree(pending.child);
      workers.delete(pending.child);
    });
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
    return inTempDir("studio-merge-", (dir) => mergeIn(dir, projectId, artifactId, base, edited, latest));
  });
}

async function mergeIn(dir, projectId, artifactId, base, edited, latest) {
  {
    const [ours, baseFile, theirs] = ["ours", "base", "theirs"].map((n) => join(dir, n));
    await Promise.all([writeFile(ours, latest.html), writeFile(baseFile, base.html), writeFile(theirs, edited)]);
    try {
      await run("git", ["merge-file", ours, baseFile, theirs]);
    } catch (error) {
      if (error?.code !== "ENOENT") return null; // overlapping edits: caller retries on the newest version
      // No git on this machine: take the worker's copy when nobody else changed the file.
      if (latest.html !== base.html) return null;
      await writeFile(ours, edited);
    }
    const out = join(dir, "publish");
    await mkdir(out);
    const target = join(out, basename(latest.entry));
    await copyFile(ours, target);
    await run(process.execPath, [
      "--import", "tsx", "src/cli/main.ts", "publish", target,
      "--server", origin, "--token-file", tokenFile,
      "--project", projectId, "--artifact", artifactId, "--expected-version", latest.versionId,
    ], {cwd: repoRoot, maxBuffer: 8 * 1024 * 1024});
    return "published";
  }
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
      // Threads stay open after the agent replies, so "delivered" alone doesn't
      // mean unfinished: adopt only threads whose last word isn't an agent reply.
      const pending = [];
      for (const threadId of dispatch.threadIds) {
        const artifactId = await locateThread(project.id, threadId).catch(() => null);
        if (artifactId === null) continue;
        const {replies, thread} = await api(`/api/v1/artifacts/${artifactId}/comments/${threadId}?projectId=${project.id}`);
        if (thread.state === "open" && replies.at(-1)?.author.principalKind !== "service") pending.push(threadId);
      }
      if (pending.length === 0) continue;
      log(`adopting ${pending.length} unfinished thread(s) from ${dispatch.id}`);
      void handleDispatch({...dispatch, threadIds: pending});
    }
  }
}

await register();
await adoptOrphans().catch((error) => log("adopt:", error.message));
setInterval(beacon, 20_000);
// Leave presence at once on shutdown, so the review never routes to a dead agent.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    for (const child of workers) killTree(child);
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
