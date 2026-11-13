import {
  HtmlViewer,
  type Annotation,
  type ViewerHandle,
} from "@plannotator/ui/components/html-viewer";
import { useCallback, useEffect, useRef, useState } from "react";

import { withBaseHref } from "./base-href.ts";
import { z } from "zod";

import { loadStudioFontCss, withStudioInjection } from "./studio-injection.ts";

const sandboxMessageSchema = z.discriminatedUnion("type", [
  z.object({type: z.literal("studio-click"), x: z.number(), y: z.number()}),
  z.object({id: z.string().min(1).max(200), type: z.literal("studio-open")}),
  z.object({type: z.literal("studio-comment-mode")}),
  z.object({type: z.literal("studio-ready")}),
]);
import {
  hostMessageSchema,
  reviewAnchorFrom,
  reviewProtocolVersion,
  type FrameMessage,
  type ReviewAnnotation,
  type ReviewInit,
  type ReviewTheme,
} from "./protocol.ts";

interface ReviewSession {
  readonly annotateModeActive: boolean;
  readonly annotations: Annotation[];
  readonly entryPath: string;
  readonly html: string;
  readonly isLight: boolean;
  /** Artifact document with its base href, before the studio head block. */
  readonly sourceHtml: string;
  readonly readOnly: boolean;
  readonly supportsAnnotateMode: boolean;
}

/** Project one host thread into the record the viewer paints and numbers. */
function toAnnotation(review: ReviewAnnotation): Annotation {
  const annotation: Annotation = {
    blockId: "",
    createdA: 0,
    endOffset: 0,
    id: review.threadId,
    originalText: review.anchor?.originalText ?? "",
    startOffset: 0,
    text: review.body,
    type: "COMMENT",
  };
  const anchor = review.anchor;
  if (anchor === null) return annotation;
  if (anchor.htmlAnchor !== null) annotation.htmlAnchor = anchor.htmlAnchor;
  if (anchor.htmlAdditionalTargets !== undefined) {
    annotation.htmlAdditionalTargets = anchor.htmlAdditionalTargets;
  }
  return annotation;
}

function sessionFrom(init: ReviewInit, fontCss: string): ReviewSession {
  const sourceHtml = withBaseHref(init.html, init.baseHref);
  return {
    annotateModeActive: init.annotateModeActive ?? true,
    annotations: init.annotations.map(toAnnotation),
    entryPath: init.entryPath,
    html: withStudioInjection(sourceHtml, init.isLight, fontCss),
    isLight: init.isLight,
    readOnly: init.readOnly,
    sourceHtml,
    supportsAnnotateMode: init.annotateModeActive !== undefined,
  };
}

function sandboxWindow(): Window | null {
  return document.querySelector("iframe")?.contentWindow ?? null;
}

/** Adopt the host's palette so the viewer chrome and the sandbox agree. */
function applyTheme(theme: ReviewInit | ReviewTheme): void {
  const root = document.documentElement;
  for (const [token, value] of Object.entries(theme.themeTokens)) {
    root.style.setProperty(token, value);
  }
  root.classList.toggle("light", theme.isLight);
}

/**
 * The review frame: a same-origin document whose only job is to host
 * `@plannotator/ui`'s sandboxed HTML annotation surface and relay its events
 * to the application shell. It holds no credential, makes no request, and
 * learns everything it renders from one validated `as-review-init` message.
 */
export function ReviewFrame(): React.ReactNode {
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const viewerRef = useRef<ViewerHandle | null>(null);
  const paintedIdsRef = useRef<ReadonlySet<string>>(new Set<string>());
  const fontCssRef = useRef("");
  const cursorsRef = useRef<readonly unknown[]>([]);
  const statusesRef = useRef<Record<string, string>>({});

  const send = useCallback((message: FrameMessage): void => {
    window.parent.postMessage(message, window.location.origin);
  }, []);

  useEffect(() => {
    // Framed by the application shell or nothing: a top-level review frame has
    // no host to authenticate against, so it never listens and never speaks.
    const framed = window.parent !== window;
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== window.parent) return;
      if (event.origin !== window.location.origin) return;
      const parsed = hostMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "as-review-init") {
        applyTheme(message);
        paintedIdsRef.current = new Set(
          message.annotations.map((annotation) => annotation.threadId),
        );
        void (async () => {
          const fontCss = await loadStudioFontCss();
          fontCssRef.current = fontCss;
          setSession(sessionFrom(message, fontCss));
        })();
        return;
      }
      if (message.type === "as-review-theme") {
        applyTheme(message);
        // The artifact follows the reader's theme too: re-render it themed.
        setSession((current) =>
          current === null || current.isLight === message.isLight
            ? current
            : {
              ...current,
              html: withStudioInjection(current.sourceHtml, message.isLight, fontCssRef.current),
              isLight: message.isLight,
            }
        );
        return;
      }
      if (message.type === "as-review-statuses") {
        statusesRef.current = message.statuses;
        sandboxWindow()?.postMessage({statuses: message.statuses, type: "studio-statuses"}, "*");
        return;
      }
      if (message.type === "as-review-locate") {
        sandboxWindow()?.postMessage({id: message.threadId, type: "studio-locate"}, "*");
        return;
      }
      if (message.type === "as-review-cursors") {
        cursorsRef.current = message.cursors;
        sandboxWindow()?.postMessage({cursors: message.cursors, type: "studio-cursors"}, "*");
        return;
      }
      if (message.type === "as-review-annotations") {
        const annotations = message.annotations.map(toAnnotation);
        setSession((current) =>
          current === null ? current : {...current, annotations}
        );
        return;
      }
      if (message.type === "as-review-annotate-mode") {
        setSession((current) =>
          current === null
            ? current
            : {...current, annotateModeActive: message.active}
        );
        return;
      }
      setSelectedThreadId(message.threadId);
    };
    // Messages the studio script inside the sandbox sends up.
    const onSandbox = (event: MessageEvent<unknown>): void => {
      const sandbox = sandboxWindow();
      if (sandbox === null || event.source !== sandbox) return;
      // The sandbox is untrusted: validate every message it sends up.
      const parsed = sandboxMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const data = parsed.data;
      if (data.type === "studio-click") {
        const frame = document.querySelector("iframe")?.getBoundingClientRect();
        send({type: "as-review-point", v: reviewProtocolVersion, x: data.x + (frame?.left ?? 0), y: data.y + (frame?.top ?? 0)});
      } else if (data.type === "studio-open") {
        send({threadId: data.id, type: "as-review-select", v: reviewProtocolVersion});
      } else if (data.type === "studio-comment-mode") {
        send({type: "as-review-comment-mode-toggle", v: reviewProtocolVersion});
      } else {
        sandbox.postMessage({cursors: cursorsRef.current, type: "studio-cursors"}, "*");
        sandbox.postMessage({statuses: statusesRef.current, type: "studio-statuses"}, "*");
      }
    };
    window.addEventListener("message", onSandbox);
    // C toggles comment mode when focus sits in this middle frame too
    // (after clicking the page or closing a comment box), not only in the shell.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "c" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement
        && (target.isContentEditable || /^(input|textarea|select)$/iu.test(target.tagName))) return;
      event.preventDefault();
      send({type: "as-review-comment-mode-toggle", v: reviewProtocolVersion});
    };
    window.addEventListener("keydown", onKey);
    if (framed) {
      window.addEventListener("message", onMessage);
      send({type: "as-review-ready", v: reviewProtocolVersion});
    }
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("message", onSandbox);
      window.removeEventListener("keydown", onKey);
    };
  }, [send]);

  // The viewer paints marks for its initial prop set when the bridge reports
  // ready; every later arrival or removal is reconciled by id so a replaced
  // optimistic annotation leaves no orphan marker behind.
  const annotations = session?.annotations;
  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer === null || annotations === undefined) return;
    const painted = paintedIdsRef.current;
    const next = new Set(annotations.map((annotation) => annotation.id));
    for (const id of painted) {
      if (!next.has(id)) viewer.removeHighlight(id);
    }
    const added = annotations.filter(
      (annotation) => !painted.has(annotation.id),
    );
    if (added.length > 0) viewer.applySharedAnnotations(added);
    paintedIdsRef.current = next;
  }, [annotations]);

  const handleAdd = useCallback((annotation: Annotation): void => {
    setSession((current) =>
      current === null
        ? current
        : {...current, annotations: [...current.annotations, annotation]}
    );
    send({
      anchor: reviewAnchorFrom(
        annotation.originalText,
        annotation.htmlAnchor,
        annotation.htmlAdditionalTargets,
      ),
      body: annotation.text ?? "",
      originalText: annotation.originalText,
      type: "as-review-submit",
      v: reviewProtocolVersion,
    });
  }, [send]);

  const handleSelect = useCallback((threadId: string | null): void => {
    setSelectedThreadId(threadId);
    send({threadId, type: "as-review-select", v: reviewProtocolVersion});
  }, [send]);

  const handleUnanchored = useCallback((threadIds: string[]): void => {
    send({threadIds, type: "as-review-unanchored", v: reviewProtocolVersion});
  }, [send]);

  const requestAnnotateMode = useCallback((active: boolean): void => {
    send({
      active,
      type: "as-review-annotate-mode-request",
      v: reviewProtocolVersion,
    });
  }, [send]);

  if (session === null) {
    return (
      <p className="p-4 text-sm text-muted-foreground" role="status">
        Waiting for the artifact to load.
      </p>
    );
  }

  return (
    <HtmlViewer
      annotateModeActive={session.annotateModeActive}
      annotations={session.annotations}
      fullViewport
      hideControls
      inputMethod="pinpoint"
      mode="comment"
      onAddAnnotation={handleAdd}
      onAnnotateModeExit={session.supportsAnnotateMode
        ? () => requestAnnotateMode(false)
        : undefined}
      onAnnotateModeToggle={session.supportsAnnotateMode
        ? () => requestAnnotateMode(!session.annotateModeActive)
        : undefined}
      onSelectAnnotation={handleSelect}
      onUnanchoredChange={handleUnanchored}
      rawHtml={session.html}
      readOnly={session.readOnly}
      ref={viewerRef}
      selectedAnnotationId={selectedThreadId}
      title={`Artifact review: ${session.entryPath}`}
    />
  );
}
