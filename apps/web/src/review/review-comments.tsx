import {Archive02Icon, ArrowTurnBackwardIcon} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {z} from "zod";

import {
  api,
  type AgentDispatch,
  type AgentPresence,
  type CommentAnchor,
  type CommentReply,
  type CommentThread,
  type CommentThreadDetails,
  type CommentThreadQuery,
} from "@/api/client";
import {CommentComposer} from "@/components/comments/comment-composer";
import {useCommentDraft} from "@/components/comments/comment-drafts";
import {maximumCommentBodyCharacters} from "@/components/comments/comment-limits";
import {CommentBody} from "@/components/comments/sketch";
import {routeComment, sessionFromTags} from "@/components/comments/routing";
import {
  mergeThreads,
  threadWatermark,
  useCommentListOwnership,
  useCommentPoll,
} from "@/components/comments/comment-poll";
import {formatTimestamp} from "@/lib/presentation";
import {bundleOfThreads} from "@/components/dispatch/dispatch-bundle";
import {loadDispatchIndex} from "@/components/dispatch/dispatch-index";
import {
  dispatchIsCancelable,
  DispatchStateChip,
} from "@/components/dispatch/dispatch-state";
import {useDispatchUndo} from "@/components/dispatch/dispatch-toast";
import {PresenceAvatar} from "@/components/dispatch/presence-avatar";
import {SendToAgentControl} from "@/components/dispatch/send-to-agent-dialog";
import {
  reviewAnchorSchema,
  type ReviewAnchor,
  type ReviewAnnotation,
} from "@/review-frame/protocol";

const threadPageSize = 100;

/**
 * Auto-send: every new comment goes straight to an agent (Claude Docs'
 * "Send to Claude", but for any connected agent of any kind or provider).
 * One dispatch per comment, so a parallel-capable agent works them at once.
 */
const autoSendKey = "studio-auto-send";

/**
 * Agents reply with the server's shared local credential ("Local"), so show the
 * agent's own name: the last agent this thread was sent to, else the connected one.
 */
export function replyAuthor(reply: CommentReply, agentNames: ReadonlyMap<string, string>): string {
  if (reply.author.principalKind !== "service") return reply.author.displayName;
  return agentNames.get(reply.threadId) ?? agentNames.get("") ?? reply.author.displayName;
}

function readAutoSend(): boolean {
  return window.localStorage.getItem(autoSendKey) !== "false";
}

async function sendThreadToAgent(
  agent: AgentPresence,
  projectId: string,
  threadId: string,
): Promise<void> {
  await api.createAgentDispatch(
    projectId,
    {agentId: agent.id, note: null, threadIds: [threadId]},
    crypto.randomUUID(),
  );
}
const conversationLoadConcurrency = 6;

function agentPresenceSummary(agents: readonly AgentPresence[] | null): string {
  if (agents === null) return "Checking presence…";
  const connectedCount = agents.filter((agent) => agent.connected).length;
  const offlineCount = agents.length - connectedCount;
  if (offlineCount === 0) {
    return connectedCount === 0 ? "No agents connected" : `${connectedCount} connected`;
  }
  return `${connectedCount} connected · ${offlineCount} offline`;
}

function threadQuery(
  _versionId: string,
  since: string | null,
  cursor: string | null,
  dispatched: "exclude" | "include" | "only" | null = "include",
): CommentThreadQuery {
  return {
    cursor,
    dispatched,
    limit: threadPageSize,
    since,
    state: null,
    // Studio: a thread lives on the artifact, not one version, so it
    // stays in view while an agent publishes the versions that address it.
    versionId: null,
  };
}

async function loadAllThreads(
  projectId: string,
  artifactId: string,
  versionId: string,
  since: string | null,
  dispatched: "exclude" | "include" | "only" | null = "include",
  cursor: string | null = null,
  collected: readonly CommentThread[] = [],
): Promise<readonly CommentThread[]> {
  const page = await api.comments(
    projectId,
    artifactId,
    threadQuery(versionId, since, cursor, dispatched),
  );
  const next = [...collected, ...page.items];
  return page.nextCursor === null
    ? next
    : loadAllThreads(
      projectId,
      artifactId,
      versionId,
      since,
      dispatched,
      page.nextCursor,
      next,
    );
}

function toAnnotation(thread: CommentThread): ReviewAnnotation {
  const parsed = reviewAnchorSchema.safeParse(thread.anchor);
  return {
    anchor: parsed.success ? parsed.data : null,
    body: thread.body,
    state: thread.state,
    threadId: thread.id,
  };
}

async function loadConversations(
  projectId: string,
  artifactId: string,
  threads: readonly CommentThread[],
): Promise<readonly CommentThreadDetails[]> {
  const conversations = new Map<string, CommentThreadDetails>();
  const worker = async (index: number): Promise<void> => {
    const thread = threads[index];
    if (thread === undefined) return;
    const details = await api.comment(projectId, artifactId, thread.id);
    conversations.set(thread.id, details);
    await worker(index + conversationLoadConcurrency);
  };
  await Promise.all(
    Array.from(
      {length: Math.min(conversationLoadConcurrency, threads.length)},
      (_, index) => worker(index),
    ),
  );
  return threads.flatMap((thread) => {
    const details = conversations.get(thread.id);
    return details === undefined ? [] : [details];
  });
}

export interface ReviewCommentSession {
  readonly artifactId: string | null;
  readonly annotations: readonly ReviewAnnotation[];
  readonly changeState: (thread: CommentThread) => Promise<void>;
  /** Threads auto-sent in this tab that their agent has not answered yet, with that agent's name. */
  readonly agentWorking: ReadonlyMap<string, string>;
  readonly autoSend: boolean;
  readonly agents: readonly AgentPresence[];
  readonly handTo: (threadId: string, agent: AgentPresence) => Promise<void>;
  /** Live and owner sessions of this artifact, as display names. */
  readonly liveSessionName: string | null;
  readonly ownerSessionName: string | null;
  /** Threads waiting for a session that isn't connected (value: whose). */
  readonly waiting: ReadonlyMap<string, string | null>;
  /** Agent display name per thread it was sent to; "" maps to the connected agent. */
  readonly agentNames: ReadonlyMap<string, string>;
  /** Name of the agent a new comment goes to, or null when none is connected. */
  readonly autoSendAgent: string | null;
  readonly setAutoSend: (value: boolean) => void;
  readonly createReply: (
    thread: CommentThread,
    body: string,
    idempotencyKey: string,
  ) => Promise<boolean>;
  readonly deleteReply: (reply: CommentReply) => Promise<void>;
  readonly error: Error | null;
  readonly loading: boolean;
  readonly projectId: string;
  readonly reload: () => Promise<void>;
  readonly repliesByThread: ReadonlyMap<string, readonly CommentReply[]>;
  readonly selectedThreadId: string | null;
  readonly selectThread: (threadId: string | null) => void;
  readonly submit: (
    body: string,
    anchor: ReviewAnchor | null,
    path: string | null,
  ) => Promise<boolean>;
  readonly threads: readonly CommentThread[];
  readonly unanchoredIds: readonly string[];
  readonly updateUnanchored: (threadIds: readonly string[]) => void;
  readonly updateReply: (reply: CommentReply, body: string) => Promise<boolean>;
}

/** Keep one Review version's saved threads and Plannotator projections in sync. */
export function useReviewComments({
  artifactId,
  artifactTags,
  onVersionChanged,
  projectId,
  versionId,
}: {
  readonly artifactId: string | null;
  /** owner:/live: session tags decide who answers (see routing.ts). */
  readonly artifactTags: readonly string[];
  readonly onVersionChanged: (versionId: string) => void;
  readonly projectId: string;
  readonly versionId: string | null;
}): ReviewCommentSession {
  const [threads, setThreads] = useState<readonly CommentThread[]>([]);
  const [repliesByThread, setRepliesByThread] = useState<ReadonlyMap<
    string,
    readonly CommentReply[]
  >>(new Map());
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [unanchoredIds, setUnanchoredIds] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [autoSend, setAutoSendState] = useState(readAutoSend);
  const [agentSent, setAgentSent] = useState<ReadonlyMap<string, string>>(new Map());
  const [agents, setAgents] = useState<readonly AgentPresence[]>([]);
  const setAutoSend = useCallback((value: boolean): void => {
    window.localStorage.setItem(autoSendKey, String(value));
    setAutoSendState(value);
  }, []);
  const loadAgents = useCallback(async (): Promise<void> => {
    try {
      setAgents(await api.agentPresence());
    } catch {
      // Presence is advisory; the last list stays.
    }
  }, []);
  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);
  useCommentPoll(loadAgents, projectId !== "");
  // Which agent session answered each thread here (follow-ups go back to it),
  // and threads waiting because their session isn't connected.
  const [threadSession, setThreadSession] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [waiting, setWaiting] = useState<ReadonlyMap<string, string | null>>(new Map());
  const liveRoute = routeComment({agents, answeringSession: null, body: "", tags: artifactTags});
  const autoSendAgent = liveRoute.kind === "send" ? liveRoute.agent : null;
  const liveSession = sessionFromTags(artifactTags, "live:");
  const ownerSession = sessionFromTags(artifactTags, "owner:");
  const sessionName = (key: string | null): string | null => key === null
    ? null
    : agents.find((agent) => agent.agentSessionId === key)?.displayName ?? `session ${key.slice(0, 6)}`;
  /** Hand a waiting thread to a connected agent the reader picked. */
  const handTo = useCallback(async (threadId: string, agent: AgentPresence): Promise<void> => {
    await sendThreadToAgent(agent, projectId, threadId);
    setAgentSent((current) => new Map([...current, [threadId, agent.displayName]]));
    setThreadSession((current) => new Map([...current, [threadId, agent.agentSessionId]]));
    setWaiting((current) => new Map([...current].filter(([id]) => id !== threadId)));
  }, [projectId]);
  const watermarkRef = useRef<string | null>(null);
  const reloadGenerationRef = useRef(0);
  const threadUpdatedAtRef = useRef<ReadonlyMap<string, string>>(new Map());
  const ownership = useCommentListOwnership();
  const active = artifactId !== null && projectId !== "" && versionId !== null;

  const reload = useCallback(async (): Promise<void> => {
    const generation = reloadGenerationRef.current + 1;
    reloadGenerationRef.current = generation;
    if (artifactId === null || projectId === "" || versionId === null) {
      setThreads([]);
      setRepliesByThread(new Map());
      setSelectedThreadId(null);
      setUnanchoredIds([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await ownership.own(async () => {
        const listedThreads = await loadAllThreads(
          projectId,
          artifactId,
          versionId,
          null,
        );
        const conversations = await loadConversations(
          projectId,
          artifactId,
          listedThreads,
        );
        if (reloadGenerationRef.current !== generation) return;
        setThreads(conversations.map(({thread}) => thread));
        setRepliesByThread(new Map(
          conversations.map(({replies, thread}) => [thread.id, replies]),
        ));
      });
    } catch (caught) {
      if (reloadGenerationRef.current !== generation) return;
      setError(
        caught instanceof Error ? caught : new Error("Comment loading failed."),
      );
    } finally {
      if (reloadGenerationRef.current === generation) setLoading(false);
    }
  }, [artifactId, ownership, projectId, versionId]);

  useEffect(() => {
    setThreads([]);
    setRepliesByThread(new Map());
    setSelectedThreadId(null);
    setUnanchoredIds([]);
    void reload();
  }, [reload]);

  useEffect(() => {
    watermarkRef.current = threadWatermark(threads);
    threadUpdatedAtRef.current = new Map(
      threads.map((thread) => [thread.id, thread.updatedAt]),
    );
    if (
      selectedThreadId !== null
      && !threads.some((thread) => thread.id === selectedThreadId)
    ) {
      setSelectedThreadId(null);
    }
  }, [selectedThreadId, threads]);

  const poll = useCallback(async (): Promise<void> => {
    if (artifactId === null || projectId === "" || versionId === null) return;
    const token = ownership.open();
    if (token < 0) return;
    try {
      const listedThreads = await loadAllThreads(
        projectId,
        artifactId,
        versionId,
        watermarkRef.current,
      );
      if (listedThreads.length === 0 || !ownership.settled(token)) return;
      const changedThreads = listedThreads.filter((thread) =>
        threadUpdatedAtRef.current.get(thread.id) !== thread.updatedAt
      );
      if (changedThreads.length === 0) return;
      const conversations = await loadConversations(
        projectId,
        artifactId,
        changedThreads,
      );
      if (!ownership.settled(token)) return;
      setThreads((current) => mergeThreads(
        current,
        conversations.map(({thread}) => thread),
      ));
      setRepliesByThread((current) => {
        const nextReplies = new Map(current);
        for (const conversation of conversations) {
          nextReplies.set(conversation.thread.id, conversation.replies);
        }
        return nextReplies;
      });
    } catch {
      // A failed background refresh leaves the last readable thread set intact.
    }
  }, [artifactId, ownership, projectId, versionId]);

  useCommentPoll(poll, active);

  const submit = useCallback(async (
    body: string,
    anchor: ReviewAnchor | null,
    path: string | null,
  ): Promise<boolean> => {
    if (artifactId === null || projectId === "" || versionId === null) return false;
    setError(null);
    try {
      const storedAnchor: CommentAnchor = z.json().parse(anchor);
      const created = await ownership.own(() =>
        api.createComment(
          projectId,
          artifactId,
          versionId,
          {anchor: storedAnchor, body, path},
          crypto.randomUUID(),
        )
      );
      const route = routeComment({agents, answeringSession: null, body, tags: artifactTags});
      const mentioned = route.kind === "send"
        && new RegExp(`@${route.agent.displayName.replace(/[^\w-]/gu, "")}\\b`, "iu").test(body);
      if (route.kind === "send" && (autoSend || mentioned)) {
        try {
          await sendThreadToAgent(route.agent, projectId, created.thread.id);
          setAgentSent((current) => new Map([...current, [created.thread.id, route.agent.displayName]]));
          setThreadSession((current) => new Map([...current, [created.thread.id, route.agent.agentSessionId]]));
        } catch {
          // The comment is saved; a failed hand-off leaves it for a manual send.
        }
      } else if (route.kind === "wait") {
        setWaiting((current) => new Map([...current, [created.thread.id, route.waitingFor]]));
      }
      if (created.thread.versionId !== versionId) {
        onVersionChanged(created.thread.versionId);
      } else {
        await reload();
        setSelectedThreadId(created.thread.id);
      }
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Comment creation failed."),
      );
      return false;
    }
  }, [agents, artifactId, artifactTags, autoSend, onVersionChanged, ownership, projectId, reload, versionId]);

  const changeState = useCallback(async (thread: CommentThread): Promise<void> => {
    if (artifactId === null || projectId === "") return;
    setError(null);
    try {
      await ownership.own(() =>
        api.updateComment(projectId, artifactId, thread.id, {
          state: thread.state === "open" ? "resolved" : "open",
        })
      );
      await reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Comment state change failed."),
      );
    }
  }, [artifactId, ownership, projectId, reload]);

  const createReply = useCallback(async (
    thread: CommentThread,
    body: string,
    idempotencyKey: string,
  ): Promise<boolean> => {
    if (artifactId === null || projectId === "" || thread.state !== "open") return false;
    setError(null);
    try {
      await ownership.own(() => api.createCommentReply(
        projectId,
        artifactId,
        thread.id,
        body,
        idempotencyKey,
      ));
      // Multi-turn: a follow-up goes back to the session that answered this thread.
      const agentInThread = (repliesByThread.get(thread.id) ?? [])
        .some((reply) => reply.author.principalKind === "service")
        || agentSent.has(thread.id);
      const route = routeComment({
        agents,
        answeringSession: threadSession.get(thread.id) ?? null,
        body,
        tags: artifactTags,
      });
      if (route.kind === "send" && (agentInThread || autoSend)) {
        try {
          await sendThreadToAgent(route.agent, projectId, thread.id);
          setAgentSent((current) => new Map([...current, [thread.id, route.agent.displayName]]));
          setThreadSession((current) => new Map([...current, [thread.id, route.agent.agentSessionId]]));
        } catch {
          // The reply is saved; the hand-off can be redone from the list.
        }
      } else if (route.kind === "wait") {
        setWaiting((current) => new Map([...current, [thread.id, route.waitingFor]]));
      }
      await reload();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Reply creation failed."));
      return false;
    }
  }, [agentSent, agents, artifactId, artifactTags, autoSend, ownership, projectId, reload, repliesByThread, threadSession]);

  const updateReply = useCallback(async (
    reply: CommentReply,
    body: string,
  ): Promise<boolean> => {
    if (artifactId === null || projectId === "") return false;
    setError(null);
    try {
      await ownership.own(() => api.updateCommentReply(
        projectId,
        artifactId,
        reply.threadId,
        reply.id,
        body,
      ));
      await reload();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Reply edit failed."));
      return false;
    }
  }, [artifactId, ownership, projectId, reload]);

  const deleteReply = useCallback(async (reply: CommentReply): Promise<void> => {
    if (artifactId === null || projectId === "") return;
    setError(null);
    try {
      await ownership.own(() => api.deleteCommentReply(
        projectId,
        artifactId,
        reply.threadId,
        reply.id,
      ));
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Reply deletion failed."));
    }
  }, [artifactId, ownership, projectId, reload]);

  const agentWorking = useMemo(() => new Map([...agentSent].filter(([id, name]) => {
    const thread = threads.find((candidate) => candidate.id === id);
    if (thread === undefined || thread.state !== "open") return false;
    // Replies carry the API key's name, not the agent's, so any agent (service) reply counts.
    return name !== "" && !(repliesByThread.get(id) ?? []).some((reply) =>
      reply.author.principalKind === "service"
    );
  })), [agentSent, repliesByThread, threads]);

  const annotations = useMemo(
    () => threads.filter((thread) => thread.state === "open").map(toAnnotation),
    [threads],
  );

  return {
    annotations,
    artifactId,
    agentWorking,
    autoSend,
    agentNames: new Map([["", autoSendAgent?.displayName ?? "Agent"], ...agentSent]),
    agents,
    handTo,
    waiting: new Map([
      ...threads
        .filter((thread) =>
          thread.state === "open"
          && !agentSent.has(thread.id)
          && (repliesByThread.get(thread.id) ?? []).at(-1)?.author.principalKind !== "service"
        )
        .flatMap((thread) => {
          const route = routeComment({
            agents,
            answeringSession: threadSession.get(thread.id) ?? null,
            body: "",
            tags: artifactTags,
          });
          return route.kind === "wait" ? [[thread.id, route.waitingFor] as const] : [];
        }),
      ...waiting,
    ]),
    liveSessionName: sessionName(liveSession),
    ownerSessionName: sessionName(ownerSession),
    autoSendAgent: autoSendAgent?.displayName ?? null,
    changeState,
    createReply,
    deleteReply,
    error,
    loading,
    projectId,
    reload,
    repliesByThread,
    selectedThreadId,
    selectThread: setSelectedThreadId,
    setAutoSend,
    submit,
    threads,
    unanchoredIds,
    updateUnanchored: setUnanchoredIds,
    updateReply,
  };
}

/** The new-thread composer, drafted per artifact and version. */
function NewThreadComposer({
  artifactId,
  principalId,
  session,
  versionId,
}: {
  readonly artifactId: string;
  readonly principalId: string;
  readonly session: ReviewCommentSession;
  readonly versionId: string;
}) {
  const draft = useCommentDraft({
    artifactId,
    principalId,
    threadId: null,
    versionId,
  });
  return (
    <div data-new-thread-composer>
      <CommentComposer
        agentToggle={session.autoSendAgent === null ? undefined : {
          checked: session.autoSend,
          label: `Send to ${session.autoSendAgent}`,
          onChange: session.setAutoSend,
        }}
        cancelLabel={null}
        draftRestored={draft.restored}
        initialBody={draft.initialBody}
        inputId={`review-new-thread-${versionId}`}
        key={`new-thread-${versionId}-${draft.restored ? "draft" : "empty"}`}
        label="Add a comment"
        maximumCharacters={maximumCommentBodyCharacters}
        onBodyChange={draft.onBodyChange}
        onCancel={null}
        onDiscardDraft={draft.onDiscard}
        onSubmit={async (body) => {
          const saved = await session.submit(body, null, null);
          if (saved) draft.onPosted();
          return saved;
        }}
        submitLabel="Post comment"
      />
    </div>
  );
}

/** One thread's reply composer, drafted per thread. */
function ReplyComposer({
  artifactId,
  initiallyExpanded = false,
  principalId,
  session,
  thread,
}: {
  readonly artifactId: string;
  readonly initiallyExpanded?: boolean;
  readonly principalId: string;
  readonly session: ReviewCommentSession;
  readonly thread: CommentThread;
}) {
  const draft = useCommentDraft({
    artifactId,
    principalId,
    threadId: thread.id,
    versionId: null,
  });
  const [expanded, setExpanded] = useState(draft.restored || initiallyExpanded);
  const [replyBody, setReplyBody] = useState(draft.initialBody);

  if (!expanded) {
    return (
      <div className="as-comment-reply-composer" data-expanded="false">
        <button
          className="as-button as-comment-reply-trigger"
          onClick={() => setExpanded(true)}
          type="button"
        >
          Reply
        </button>
      </div>
    );
  }

  return (
    <div className="as-comment-reply-composer" data-expanded="true">
      <CommentComposer
        cancelLabel="Cancel"
        draftRestored={draft.restored}
        initialBody={replyBody}
        inputId={`review-reply-${thread.id}`}
        label="Reply"
        maximumCharacters={maximumCommentBodyCharacters}
        onBodyChange={(body) => {
          setReplyBody(body);
          draft.onBodyChange(body);
        }}
        onCancel={() => setExpanded(false)}
        onDiscardDraft={() => {
          setReplyBody("");
          draft.onDiscard();
        }}
        onSubmit={async (body, idempotencyKey) => {
          const saved = await session.createReply(thread, body, idempotencyKey);
          if (saved) {
            setReplyBody("");
            draft.onPosted();
            setExpanded(false);
          }
          return saved;
        }}
        submitLabel="Post reply"
      />
    </div>
  );
}

type CommentView = "all" | "open" | "resolved" | "sent";

export interface ReviewCommentsInspectorHandle {
  readonly reload: () => Promise<void>;
}

/** Review-native thread list kept beside, never over, the artifact. */
export const ReviewCommentsInspector = forwardRef<ReviewCommentsInspectorHandle, {
  readonly canDeleteAny: boolean;
  readonly canComment: boolean;
  readonly principalId: string;
  readonly session: ReviewCommentSession;
  readonly versionId: string | null;
}>(function ReviewCommentsInspector({
  canDeleteAny,
  canComment,
  principalId,
  session,
  versionId,
}, ref) {
  const unanchored = new Set(session.unanchoredIds);
  const [agents, setAgents] = useState<readonly AgentPresence[] | null>(null);
  const [agentError, setAgentError] = useState<Error | null>(null);
  const [view, setView] = useState<CommentView>("all");
  const [sentThreads, setSentThreads] = useState<readonly CommentThread[]>([]);
  const [sentReplies, setSentReplies] = useState<ReadonlyMap<
    string,
    readonly CommentReply[]
  >>(new Map());
  const [dispatchByThread, setDispatchByThread] = useState<ReadonlyMap<
    string,
    AgentDispatch
  >>(new Map());
  const [sentLoading, setSentLoading] = useState(false);
  const [sentError, setSentError] = useState<Error | null>(null);

  const loadAgents = useCallback(async (): Promise<void> => {
    try {
      setAgents(await api.agentPresence());
      setAgentError(null);
    } catch (caught) {
      setAgentError(caught instanceof Error ? caught : new Error("Agent presence failed."));
    }
  }, []);

  const loadSent = useCallback(async (): Promise<void> => {
    if (session.artifactId === null || session.projectId === "" || versionId === null) {
      setSentThreads([]);
      setSentReplies(new Map());
      setDispatchByThread(new Map());
      return;
    }
    setSentLoading(true);
    setSentError(null);
    try {
      const listed = await loadAllThreads(
        session.projectId,
        session.artifactId,
        versionId,
        null,
        "only",
      );
      const [conversations, index] = await Promise.all([
        loadConversations(session.projectId, session.artifactId, listed),
        loadDispatchIndex(session.projectId, listed.map((thread) => thread.id)),
      ]);
      setSentThreads(conversations.map(({thread}) => thread));
      setSentReplies(new Map(
        conversations.map(({replies, thread}) => [thread.id, replies]),
      ));
      setDispatchByThread(index);
    } catch (caught) {
      setSentError(caught instanceof Error ? caught : new Error("Sent comments failed."));
    } finally {
      setSentLoading(false);
    }
  }, [session.artifactId, session.projectId, versionId]);

  const reloadDispatchSurface = useCallback(async (): Promise<void> => {
    await Promise.all([session.reload(), loadSent(), loadAgents()]);
  }, [loadAgents, loadSent, session.reload]);
  useImperativeHandle(ref, () => ({reload: reloadDispatchSurface}), [reloadDispatchSurface]);
  const dispatchUndo = useDispatchUndo(session.projectId, reloadDispatchSurface);

  useEffect(() => {
    void Promise.all([loadAgents(), loadSent()]);
  }, [loadAgents, loadSent]);
  useCommentPoll(loadAgents, session.projectId !== "");
  useCommentPoll(
    loadSent,
    view === "sent" && session.artifactId !== null && versionId !== null,
  );

  const openThreads = session.threads.filter((thread) => thread.state === "open");
  const resolvedThreads = session.threads.filter((thread) => thread.state === "resolved");
  const visibleThreads = view === "sent"
    ? sentThreads
    : view === "all"
      ? [...openThreads, ...resolvedThreads]
      : view === "open"
        ? openThreads
        : resolvedThreads;
  const visibleReplies = view === "sent" ? sentReplies : session.repliesByThread;
  const loadingVisible = view === "sent" ? sentLoading : session.loading;
  const now = Date.now();

  const cancelDispatch = async (dispatch: AgentDispatch): Promise<void> => {
    setSentError(null);
    try {
      await api.cancelAgentDispatch(session.projectId, dispatch.id);
      await reloadDispatchSurface();
    } catch (caught) {
      setSentError(caught instanceof Error ? caught : new Error("Cancel failed."));
    }
  };

  const onSent = async (): Promise<void> => {
    await reloadDispatchSurface();
  };

  return (
    <div className="as-comments">
      {dispatchUndo.element}
      <div className="as-comments__agents">
        <div>
          <strong>Agents</strong>
          <span>{agentPresenceSummary(agents)}</span>
        </div>
        <div aria-label="Agent presence" role="group">
          {agents?.map((agent) => (
            <PresenceAvatar agent={agent} key={agent.id} now={now} />
          ))}
        </div>
      </div>
      {agentError === null ? null : (
        <p className="as-comments__agent-error">{agentError.message}</p>
      )}
      {canComment ? (
        <div className="as-comments__send-all">
          <SendToAgentControl
            agents={agents}
            buttonSize="xs"
            buttonVariant="default"
            feedback={dispatchUndo.feedback}
            label={`Send all open (${openThreads.length})…`}
            onSent={onSent}
            oneAgentLabel={(name) => `Send all open (${openThreads.length}) to ${name}`}
            openCount={openThreads.length}
            principalId={principalId}
            projectId={session.projectId}
            resolveBundle={() => Promise.resolve(bundleOfThreads(openThreads))}
          />
        </div>
      ) : null}
      {canComment ? null : (
        <p className="as-comments__read-only">
          Comments are read-only for this account or archived project.
        </p>
      )}
      {session.error === null ? null : (
        <p className="as-comments__error" role="alert">{session.error.message}</p>
      )}
      {sentError === null ? null : (
        <p className="as-comments__error" role="alert">{sentError.message}</p>
      )}
      <nav aria-label="Comment filters" className="as-comments__filters">
        {(["open", "all", "resolved", "sent"] as const).map((candidate) => (
          <button
            aria-pressed={view === candidate}
            className="as-button"
            key={candidate}
            onClick={() => setView(candidate)}
            type="button"
          >
            {candidate === "all"
              ? "All"
              : candidate === "sent"
                ? `Sent (${sentThreads.length})`
                : `${candidate[0]?.toUpperCase()}${candidate.slice(1)}`}
          </button>
        ))}
      </nav>
      {canComment && versionId !== null && session.artifactId !== null ? (
        <NewThreadComposer
          artifactId={session.artifactId}
          key={`${session.artifactId}-${versionId}`}
          principalId={principalId}
          session={session}
          versionId={versionId}
        />
      ) : null}
      {loadingVisible && visibleThreads.length === 0 ? (
        <p className="as-inspector-empty">Loading comments…</p>
      ) : null}
      {!loadingVisible && visibleThreads.length === 0 ? (
        <p className="as-inspector-empty">
          {view === "all"
            ? "No comments on this version yet."
            : view === "sent"
              ? "No sent comments on this version."
              : view === "open" && resolvedThreads.length > 0
                ? "All comments on this version are resolved."
                : `No ${view} comments on this version.`}
        </p>
      ) : null}
      <ol className="as-comment-list">
        {visibleThreads.map((thread) => {
          const sentDispatch = view === "sent" ? dispatchByThread.get(thread.id) : undefined;
          const replies = visibleReplies.get(thread.id) ?? [];
          return (
            <li key={thread.id}>
              <article
                aria-current={session.selectedThreadId === thread.id ? "true" : undefined}
                className="as-comment-card"
                data-selected={session.selectedThreadId === thread.id}
              >
                <header data-initial={thread.author.displayName.slice(0, 1).toUpperCase()}>
                  <strong>{thread.author.displayName}</strong>
                  {sentDispatch === undefined
                    ? <span data-state={thread.state}>{thread.state}</span>
                    : <DispatchStateChip state={sentDispatch.state} />}
                </header>
                <div className="as-comment-card__body">
                  <CommentBody body={thread.body} />
                  <footer>
                    <div className="as-comment-card__meta">
                      <span>
                        Updated <time dateTime={thread.updatedAt}>
                          {formatTimestamp(thread.updatedAt)}
                        </time>
                      </span>
                      <span>
                        {thread.path === null ? "Whole version" : (
                          <>Page <code>{thread.path}</code></>
                        )}
                      </span>
                    </div>
                    {view !== "sent" && unanchored.has(thread.id) ? (
                      <small>Location unavailable in this version</small>
                    ) : null}
                    <div className="as-comment-card__actions">
                      {view === "sent" ? (
                        sentDispatch !== undefined && dispatchIsCancelable(sentDispatch.state) ? (
                          <button
                            className="as-button"
                            onClick={() => void cancelDispatch(sentDispatch)}
                            type="button"
                          >
                            Cancel send
                          </button>
                        ) : null
                      ) : (
                        <>
                          {canComment && thread.state === "open" ? (
                            <SendToAgentControl
                              agents={agents}
                              buttonSize="xs"
                              buttonVariant="outline"
                              feedback={dispatchUndo.feedback}
                              label="Send…"
                              onSent={onSent}
                              oneAgentLabel={(name) => `Send to ${name}`}
                              openCount={1}
                              principalId={principalId}
                              projectId={session.projectId}
                              reasonDisplay="hidden"
                              resolveBundle={() => Promise.resolve(bundleOfThreads([thread]))}
                            />
                          ) : null}
                          {thread.path === null ? null : (
                            <button
                              className="as-button"
                              onClick={() => session.selectThread(thread.id)}
                              type="button"
                            >
                              Show in page
                            </button>
                          )}
                          {canComment ? (
                            <button
                              className="as-button"
                              onClick={() => void session.changeState(thread)}
                              type="button"
                            >
                              {thread.state === "open" ? "Resolve" : "Reopen"}
                            </button>
                          ) : null}
                        </>
                      )}
                    </div>
                  </footer>
                </div>
                {replies.length === 0 ? null : (
                  <section
                    aria-label={`${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
                    className="as-comment-card__conversation"
                  >
                    <p className="as-comment-card__conversation-label">
                      {replies.length} {replies.length === 1 ? "reply" : "replies"}
                    </p>
                    <ol className="as-comment-replies">
                      {replies.map((reply) => (
                        <ReviewReply
                          agentNames={session.agentNames}
                          canDeleteAny={canDeleteAny}
                          canMutate={canComment}
                          key={reply.id}
                          onDelete={session.deleteReply}
                          onUpdate={session.updateReply}
                          principalId={principalId}
                          reply={reply}
                        />
                      ))}
                    </ol>
                  </section>
                )}
                {session.agentWorking.has(thread.id) ? (
                  <p className="as-agent-working" role="status">
                    {`${session.agentWorking.get(thread.id) ?? "Agent"} is working…`}
                  </p>
                ) : null}
                {session.waiting.has(thread.id) ? (
                  <WaitingFor
                    agents={session.agents}
                    onHand={(agent) => void session.handTo(thread.id, agent)}
                    whom={session.waiting.get(thread.id) ?? null}
                  />
                ) : null}
                {view !== "sent" && canComment && thread.state === "open"
                    && session.artifactId !== null ? (
                  <ReplyComposer
                    artifactId={session.artifactId}
                    principalId={principalId}
                    session={session}
                    thread={thread}
                  />
                ) : null}
              </article>
            </li>
          );
        })}
      </ol>
    </div>
  );
});

function ReviewReply({
  agentNames,
  canDeleteAny,
  canMutate,
  onDelete,
  onUpdate,
  principalId,
  reply,
}: {
  readonly agentNames: ReadonlyMap<string, string>;
  readonly canDeleteAny: boolean;
  readonly canMutate: boolean;
  readonly onDelete: (reply: CommentReply) => Promise<void>;
  readonly onUpdate: (reply: CommentReply, body: string) => Promise<boolean>;
  readonly principalId: string;
  readonly reply: CommentReply;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const editorId = useId();
  const ownReply = reply.author.principalId === principalId;
  const remove = async (): Promise<void> => {
    setDeleting(true);
    await onDelete(reply);
    setDeleting(false);
  };
  return (
    <li data-agent={reply.author.principalKind === "service"}>
      <header>
        <strong>{replyAuthor(reply, agentNames)}</strong>
        <time dateTime={reply.updatedAt}>{formatTimestamp(reply.updatedAt)}</time>
      </header>
      {editing ? (
        <CommentComposer
          cancelLabel="Cancel"
          initialBody={reply.body}
          inputId={editorId}
          label="Edit reply"
          maximumCharacters={maximumCommentBodyCharacters}
          onCancel={() => setEditing(false)}
          onSubmit={async (body) => {
            const changed = await onUpdate(reply, body);
            if (changed) setEditing(false);
            return changed;
          }}
          submitLabel="Save reply"
        />
      ) : <CommentBody body={reply.body} />}
      {!canMutate || editing || (!ownReply && !canDeleteAny) ? null : (
        <div className="as-comment-reply__actions">
          {ownReply ? (
            <button className="as-button" onClick={() => setEditing(true)} type="button">
              Edit
            </button>
          ) : null}
          <button
            className="as-button"
            disabled={deleting}
            onClick={() => void remove()}
            type="button"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * Claude-artifacts style: one thread opens in a small card floating by where
 * it lives on the page, not in a side panel. Escape or clicking away closes it.
 * Resolving is a keyboard-free click on the check; replying is the only field.
 */
export function ThreadPopover({
  canComment,
  onClose,
  point,
  principalId,
  session,
}: {
  readonly canComment: boolean;
  readonly onClose: () => void;
  readonly point: {readonly x: number; readonly y: number} | null;
  readonly principalId: string;
  readonly session: ReviewCommentSession;
}) {
  const thread = session.threads.find((candidate) => candidate.id === session.selectedThreadId);
  const cardRef = useRef<HTMLElement | null>(null);
  // Measured placement: the whole card always stays inside the window.
  const [place, setPlace] = useState<{left: number; maxHeight: number; top: number} | null>(null);
  const width = 300;
  const margin = 12;
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card === null) return;
    // Google Docs: the card lives in the right margin, level with its text,
    // and never leaves the artifact pane (no covering the header).
    const pane = card.parentElement?.getBoundingClientRect();
    const paneTop = (pane?.top ?? 0) + margin;
    const paneBottom = (pane?.bottom ?? window.innerHeight) - margin;
    const maxHeight = paneBottom - paneTop;
    const height = Math.min(card.scrollHeight, maxHeight);
    const anchorY = point?.y ?? paneTop;
    setPlace({
      left: Math.max(margin, (pane?.right ?? window.innerWidth) - width - 20),
      maxHeight,
      top: Math.min(Math.max(paneTop, anchorY - 24), paneBottom - height),
    });
  }, [point, thread?.id, session.repliesByThread]);
  // A new message scrolls into view: the conversation reads bottom-up like chat.
  const replyCount = thread === undefined ? 0 : (session.repliesByThread.get(thread.id) ?? []).length;
  useEffect(() => {
    // After placement settles (max height applied, sketches laid out).
    const frame = window.requestAnimationFrame(() => {
      const card = cardRef.current;
      if (card !== null) card.scrollTop = card.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [place, replyCount, thread?.id]);
  useEffect(() => {
    if (thread === undefined) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const onDown = (event: PointerEvent): void => {
      const target = event.target;
      if (cardRef.current !== null && target instanceof Node && !cardRef.current.contains(target)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose, thread]);
  if (thread === undefined || session.artifactId === null) return null;
  const replies = session.repliesByThread.get(thread.id) ?? [];
  return (
    <aside
      aria-label={`Comment by ${thread.author.displayName}`}
      className="as-thread-popover"
      ref={cardRef}
      style={{
        left: place?.left ?? margin,
        maxHeight: place?.maxHeight ?? `calc(100vh - ${margin * 2}px)`,
        top: place?.top ?? margin,
        visibility: place === null ? "hidden" : "visible",
        width,
      }}
    >
      <article className="as-comment-card" data-selected="true">
        <header data-initial={thread.author.displayName.slice(0, 1).toUpperCase()}>
          <strong>{thread.author.displayName}</strong>
          {canComment ? (
            <button
              aria-label={thread.state === "open" ? "Archive" : "Restore"}
              className="as-thread-popover__resolve"
              data-state={thread.state}
              onClick={() => {
                void session.changeState(thread);
                if (thread.state === "open") onClose();
              }}
              title={thread.state === "open" ? "Archive (stays under Resolved)" : "Restore"}
              type="button"
            >
              <HugeiconsIcon aria-hidden="true" icon={thread.state === "open" ? Archive02Icon : ArrowTurnBackwardIcon} strokeWidth={1.8} />
            </button>
          ) : null}
        </header>
        <div className="as-comment-card__body">
          <CommentBody body={thread.body} />
        </div>
        {replies.length === 0 ? null : (
          <ol className="as-comment-replies">
            {replies.map((reply) => (
              <li data-agent={reply.author.principalKind === "service"} key={reply.id}>
                <header>
                  <strong>{replyAuthor(reply, session.agentNames)}</strong>
                  <time dateTime={reply.updatedAt}>{formatTimestamp(reply.updatedAt)}</time>
                </header>
                <CommentBody body={reply.body} />
              </li>
            ))}
          </ol>
        )}
        {session.waiting.has(thread.id) ? (
          <WaitingFor
            agents={session.agents}
            onHand={(agent) => void session.handTo(thread.id, agent)}
            whom={session.waiting.get(thread.id) ?? null}
          />
        ) : null}
        {canComment && thread.state === "open" ? (
          <InlineReply key={thread.id} session={session} thread={thread} principalId={principalId} />
        ) : null}
      </article>
    </aside>
  );
}

/** One-line reply field: Return sends, Shift+Return breaks the line. No buttons. */
function InlineReply({
  principalId,
  session,
  thread,
}: {
  readonly principalId: string;
  readonly session: ReviewCommentSession;
  readonly thread: CommentThread;
}) {
  const draft = useCommentDraft({
    artifactId: session.artifactId ?? "",
    principalId,
    threadId: thread.id,
    versionId: null,
  });
  const [body, setBody] = useState(draft.initialBody);
  const [pending, setPending] = useState(false);
  const attemptKey = useRef<string | null>(null);
  const send = async (): Promise<void> => {
    const trimmed = body.trim();
    if (trimmed === "" || pending || trimmed.length > maximumCommentBodyCharacters) return;
    attemptKey.current ??= crypto.randomUUID();
    setPending(true);
    const saved = await session.createReply(thread, trimmed, attemptKey.current);
    setPending(false);
    if (!saved) return;
    attemptKey.current = null;
    setBody("");
    draft.onPosted();
  };
  return (
    <textarea
      aria-label="Reply"
      className="as-thread-popover__reply"
      disabled={pending}
      onChange={(event) => {
        setBody(event.currentTarget.value);
        draft.onBodyChange(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void send();
        }
      }}
      placeholder="Reply…"
      rows={1}
      value={body}
    />
  );
}

/** A thread whose session isn't connected waits; the reader may hand it on. */
function WaitingFor({
  agents,
  onHand,
  whom,
}: {
  readonly agents: readonly AgentPresence[];
  readonly onHand: (agent: AgentPresence) => void;
  readonly whom: string | null;
}) {
  const connected = agents.filter((agent) => agent.connected);
  return (
    <div className="as-waiting">
      <p>{whom === null ? "No agent session is working on this artifact." : `Waiting for ${whom} (not connected).`}</p>
      {connected.length === 0 ? null : (
        <div className="as-waiting__agents">
          <span>Hand to</span>
          {connected.map((agent) => (
            <button key={agent.id} onClick={() => onHand(agent)} type="button">{agent.displayName}</button>
          ))}
        </div>
      )}
    </div>
  );
}
