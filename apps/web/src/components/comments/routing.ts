/**
 * Who answers a comment (Studio session ownership):
 *
 *   1. an @mention of a connected agent wins
 *   2. a thread keeps the agent session that already answered it
 *   3. a new comment goes to the artifact's live session (tag live:<key>)
 *   4. else to its owner session (tag owner:<key>)
 *   5. else nobody: the comment waits for the reader to pick an agent
 *
 * A session that isn't connected is never replaced by a different one
 * automatically: the comment waits instead, and the UI says for whom.
 */

/** The fields of an agent presence row that routing reads. */
export interface RoutableAgent {
  readonly agentSessionId: string | null;
  readonly connected: boolean;
  readonly displayName: string;
  readonly id: string;
}

export type Route<A extends RoutableAgent = RoutableAgent> =
  | {readonly agent: A; readonly kind: "send"}
  | {readonly kind: "wait"; readonly waitingFor: string | null};

export function sessionFromTags(tags: readonly string[], prefix: "live:" | "owner:"): string | null {
  return tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function mentioned<A extends RoutableAgent>(agents: readonly A[], body: string): A | undefined {
  return agents.find((agent) =>
    agent.connected
    && new RegExp(`(^|\\s)@${agent.displayName.replace(/[^\w-]/gu, "")}\\b`, "iu").test(body)
  );
}

export function routeComment<A extends RoutableAgent>({
  agents,
  answeringSession,
  body,
  tags,
}: {
  readonly agents: readonly A[];
  /** The session that last answered this thread, for follow-ups; null for new threads. */
  readonly answeringSession: string | null;
  readonly body: string;
  readonly tags: readonly string[];
}): Route<A> {
  const byMention = mentioned(agents, body);
  if (byMention !== undefined) return {agent: byMention, kind: "send"};
  const wanted = answeringSession
    ?? sessionFromTags(tags, "live:")
    ?? sessionFromTags(tags, "owner:");
  if (wanted === null) return {kind: "wait", waitingFor: null};
  const agent = agents.find((candidate) => candidate.agentSessionId === wanted && candidate.connected);
  if (agent !== undefined) return {agent, kind: "send"};
  // The live session is gone: the owner may still be around.
  const owner = sessionFromTags(tags, "owner:");
  const ownerAgent = answeringSession === null && owner !== wanted
    ? agents.find((candidate) => candidate.agentSessionId === owner && candidate.connected)
    : undefined;
  if (ownerAgent !== undefined) return {agent: ownerAgent, kind: "send"};
  const known = agents.find((candidate) => candidate.agentSessionId === wanted);
  return {kind: "wait", waitingFor: known?.displayName ?? `session ${wanted.slice(0, 6)}`};
}
