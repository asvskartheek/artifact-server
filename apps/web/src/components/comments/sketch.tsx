/**
 * Sketches: the tiny visual language agents (and people) can use in comments.
 *
 *   ```sketch
 *   A[Long hero title] -> B[Short title]!: cut to 6 words
 *   B -> C(Shipped)
 *   ```
 *
 * `[x]` is a box, `(x)` a pill, a trailing `!` highlights a node, `: text`
 * labels an arrow. Writers send text; this renders it hand-drawn. No library,
 * and the writer never authors SVG.
 */

import {parseSketch, type Sketch, type SketchNode} from "./sketch-parse";

export {parseSketch};

/** Rank = longest path from a source, so arrows point down. Cycle-safe. */
function ranks(sketch: Sketch): Map<string, number> {
  const rank = new Map(sketch.nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < sketch.nodes.length; pass += 1) {
    let changed = false;
    for (const edge of sketch.edges) {
      const next = (rank.get(edge.from) ?? 0) + 1;
      if (next > (rank.get(edge.to) ?? 0) && next < sketch.nodes.length) {
        rank.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rank;
}

/** Deterministic wobble so a sketch looks hand-drawn but never jitters on re-render. */
function wobble(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state / 2147483647 - 0.5) * 2;
  };
}

function hash(text: string): number {
  let value = 7;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) % 2147483647;
  return value;
}

function roughBox(x: number, y: number, w: number, h: number, pill: boolean, rnd: () => number): string {
  if (pill) {
    const r = h / 2;
    return `M${x + r + rnd()},${y + rnd()} H${x + w - r + rnd()} A${r},${r} 0 0 1 ${x + w - r + rnd()},${y + h + rnd()} H${x + r + rnd()} A${r},${r} 0 0 1 ${x + r + rnd()},${y + rnd()}`;
  }
  const j = () => rnd() * 1.4;
  return `M${x + j()},${y + j()} L${x + w + j()},${y + j()} L${x + w + j()},${y + h + j()} L${x + j()},${y + h + j()} Z`;
}

/** Up to two lines that fit the box, breaking on spaces; ellipsis only past that. */
function fitLines(label: string, width: number): readonly string[] {
  const max = Math.max(4, Math.floor((width - 14) / 5.6));
  const lines: string[] = [];
  let line = "";
  for (const word of label.split(/\s+/u)) {
    const next = line === "" ? word : `${line} ${word}`;
    if (next.length <= max) {
      line = next;
    } else {
      if (line !== "") lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  if (lines.length <= 2) return lines.map((text) => text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const second = lines.slice(1).join(" ");
  return [lines[0] ?? "", `${second.slice(0, max - 1)}…`];
}

export function SketchView({source}: {readonly source: string}) {
  const sketch = parseSketch(source);
  if (sketch.nodes.length === 0) return <pre className="as-sketch-raw">{source}</pre>;
  const rank = ranks(sketch);
  const rows = new Map<number, SketchNode[]>();
  for (const node of sketch.nodes) {
    const row = rank.get(node.id) ?? 0;
    rows.set(row, [...(rows.get(row) ?? []), node]);
  }
  const width = 300;
  const boxH = 38;
  const rowGap = 38;
  const place = new Map<string, {x: number; y: number; w: number}>();
  for (const [row, members] of rows) {
    // Share the row; a lone node may use the full width so its label fits.
    const room = (width - 8 - (members.length - 1) * 12) / members.length;
    const widths = members.map((node) => Math.min(room, Math.max(60, Math.ceil(node.label.length / 2) * 6 + 22)));
    const total = widths.reduce((sum, w) => sum + w, 0) + (members.length - 1) * 12;
    let x = Math.max(4, (width - total) / 2);
    members.forEach((node, index) => {
      const w = widths[index] ?? 60;
      place.set(node.id, {w, x, y: 6 + row * (boxH + rowGap)});
      x += w + 12;
    });
  }
  const height = 12 + rows.size * (boxH + rowGap) - rowGap;
  const rnd = wobble(hash(source));
  return (
    <svg
      aria-label="Sketch"
      className="as-sketch"
      role="img"
      viewBox={`0 0 ${width} ${height}`}
    >
      <defs>
        <marker id="as-sketch-head" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5">
          <path d="M0,0 L7,3.5 L0,7" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </marker>
      </defs>
      {sketch.edges.map((edge, index) => {
        const a = place.get(edge.from);
        const b = place.get(edge.to);
        if (a === undefined || b === undefined) return null;
        const x1 = a.x + a.w / 2;
        const y1 = a.y + boxH;
        const x2 = b.x + b.w / 2;
        const y2 = b.y - 2;
        const bend = rnd() * 10;
        const midY = (y1 + y2) / 2;
        return (
          <g key={`${edge.from}-${edge.to}-${index}`}>
            <path
              d={`M${x1},${y1 + 2} C${x1 + bend},${midY} ${x2 - bend},${midY} ${x2},${y2}`}
              fill="none"
              markerEnd="url(#as-sketch-head)"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.3"
            />
            {edge.label === "" ? null : (
              <text className="as-sketch__edge" textAnchor="middle" x={(x1 + x2) / 2} y={midY + 3}>
                {edge.label.length > 18 ? `${edge.label.slice(0, 17)}…` : edge.label}
              </text>
            )}
          </g>
        );
      })}
      {sketch.nodes.map((node) => {
        const at = place.get(node.id);
        if (at === undefined) return null;
        return (
          <g className="as-sketch__node" data-hot={node.hot} key={node.id}>
            <path className="as-sketch__fill" d={roughBox(at.x, at.y, at.w, boxH, node.pill, rnd)} />
            <path className="as-sketch__line" d={roughBox(at.x, at.y, at.w, boxH, node.pill, rnd)} fill="none" />
            <text textAnchor="middle" x={at.x + at.w / 2} y={at.y + boxH / 2 + 4}>
              {fitLines(node.label, at.w).map((text, index, all) => (
                <tspan dy={index === 0 ? (all.length - 1) * -6.5 : 13} key={index} x={at.x + at.w / 2}>{text}</tspan>
              ))}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** `code` spans render as code; everything else stays plain text (never HTML). */
function withInlineCode(text: string): React.ReactNode[] {
  return text.split(/`([^`\n]+)`/u).map((piece, index) =>
    index % 2 === 1 ? <code key={index}>{piece}</code> : piece
  );
}

/** A comment or reply body: text, with any ```sketch blocks drawn in place. */
export function CommentBody({body}: {readonly body: string}) {
  const parts = body.split(/```sketch\s*\n([\s\S]*?)```/u);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1
          ? <SketchView key={index} source={part} />
          : part.trim() === "" ? null : <p key={index}>{withInlineCode(part.trim())}</p>
      )}
    </>
  );
}
