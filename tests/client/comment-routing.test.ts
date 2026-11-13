import {describe, expect, it} from "vitest";

import {routeComment, type RoutableAgent} from "../../apps/web/src/components/comments/routing.js";

const agent = (id: string, session: string | null, connected = true, name = id): RoutableAgent =>
  ({agentSessionId: session, connected, displayName: name, id});

const piA = agent("a", "aaa", true, "pi-league");
const piB = agent("b", "bbb", true, "pi-other");
const shared = agent("s", null, true, "Copilot");

describe("comment routing", () => {
  it("sends a new comment to the live session, not the shared agent", () => {
    const route = routeComment({agents: [shared, piB, piA], answeringSession: null, body: "fix", tags: ["owner:aaa", "live:bbb"]});
    expect(route).toEqual({agent: piB, kind: "send"});
  });

  it("keeps a thread with the session that answered it", () => {
    const route = routeComment({agents: [piA, piB], answeringSession: "aaa", body: "and?", tags: ["owner:aaa", "live:bbb"]});
    expect(route).toEqual({agent: piA, kind: "send"});
  });

  it("falls back to the owner when the live session is gone", () => {
    const route = routeComment({agents: [piA, agent("b", "bbb", false)], answeringSession: null, body: "x", tags: ["owner:aaa", "live:bbb"]});
    expect(route).toEqual({agent: piA, kind: "send"});
  });

  it("waits instead of handing a closed session's thread to someone else", () => {
    const route = routeComment({agents: [shared, agent("a", "aaa", false, "pi-league")], answeringSession: "aaa", body: "x", tags: ["owner:aaa", "live:aaa"]});
    expect(route).toEqual({kind: "wait", waitingFor: "pi-league"});
  });

  it("never auto-sends an unowned artifact's comments to the shared agent", () => {
    expect(routeComment({agents: [shared], answeringSession: null, body: "x", tags: []}))
      .toEqual({kind: "wait", waitingFor: null});
  });

  it("an @mention always wins", () => {
    const route = routeComment({agents: [shared, piA], answeringSession: "aaa", body: "@Copilot please", tags: ["live:aaa"]});
    expect(route).toEqual({agent: shared, kind: "send"});
  });
});
