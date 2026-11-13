import {describe, expect, it} from "vitest";

import {parseSketch} from "../../apps/web/src/components/comments/sketch-parse.ts";

describe("comment sketches", () => {
  it("reads boxes, pills, highlights and labelled arrows", () => {
    const sketch = parseSketch("A[Long title] -> B[Short]!: cut\nB -> C(Shipped)");
    expect(sketch.nodes.map((node) => [node.id, node.label, node.pill, node.hot])).toEqual([
      ["A", "Long title", false, false],
      ["B", "Short", false, true],
      ["C", "Shipped", true, false],
    ]);
    expect(sketch.edges).toEqual([
      {from: "A", label: "cut", to: "B"},
      {from: "B", label: "", to: "C"},
    ]);
  });

  it("keeps colons inside labels and skips junk lines", () => {
    const sketch = parseSketch("A[ratio: 2] -> B\n%%% nonsense ->\n");
    expect(sketch.nodes.find((node) => node.id === "A")?.label).toBe("ratio: 2");
    expect(sketch.edges).toHaveLength(1);
  });
});
