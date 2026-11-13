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

export interface SketchNode {
  readonly id: string;
  label: string;
  pill: boolean;
  hot: boolean;
}

export interface SketchEdge {
  readonly from: string;
  readonly label: string;
  readonly to: string;
}

export interface Sketch {
  readonly edges: readonly SketchEdge[];
  readonly nodes: readonly SketchNode[];
}

const nodePattern = /^\s*([\w-]+)\s*(?:\[([^\]]*)\]|\(([^)]*)\))?\s*(!)?\s*$/u;

function readNode(text: string, nodes: Map<string, SketchNode>): string | null {
  const match = nodePattern.exec(text);
  if (match === null) return null;
  const [, id = "", box, pill, hot] = match;
  const node = nodes.get(id) ?? {hot: false, id, label: id, pill: false};
  if (box !== undefined) node.label = box;
  if (pill !== undefined) {
    node.label = pill;
    node.pill = true;
  }
  if (hot !== undefined) node.hot = true;
  nodes.set(id, node);
  return id;
}

/** Parse a sketch; unreadable lines are skipped, never fatal. */
export function parseSketch(source: string): Sketch {
  const nodes = new Map<string, SketchNode>();
  const edges: SketchEdge[] = [];
  for (const line of source.split("\n").slice(0, 60)) {
    if (line.trim() === "") continue;
    const arrow = line.indexOf("->");
    if (arrow < 0) {
      readNode(line, nodes);
      continue;
    }
    const left = line.slice(0, arrow);
    const rest = line.slice(arrow + 2);
    const colon = rest.search(/:(?![^[(]*[\])])/u);
    const right = colon < 0 ? rest : rest.slice(0, colon);
    const from = readNode(left, nodes);
    const to = readNode(right, nodes);
    if (from !== null && to !== null) {
      edges.push({from, label: colon < 0 ? "" : rest.slice(colon + 1).trim(), to});
    }
  }
  return {edges, nodes: [...nodes.values()].slice(0, 24)};
}

