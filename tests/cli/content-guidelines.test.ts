import {describe, expect, it} from "vitest";

import {checkContentGuidelines} from "../../src/cli/content-guidelines.js";

const wall = Array.from({length: 80}, () => "word").join(" ");

describe("studio content guidelines", () => {
  it("passes a visual explainer with quizzes", () => {
    const html = `<title>How the cache works</title>
      <section><h2>One</h2><svg></svg></section>
      <section><h2>Two</h2><p>Short note.</p></section>
      <div data-quiz><button>A</button></div>`;
    expect(checkContentGuidelines(html).problems).toEqual([]);
  });

  it("refuses a page with no visual or widget", () => {
    const report = checkContentGuidelines("<h1>Notes</h1><p>Just text.</p>");
    expect(report.problems.join(" ")).toMatch(/No visual or interactive/u);
  });

  it("refuses walls of text", () => {
    const report = checkContentGuidelines(`<svg></svg><p>${wall}</p>`);
    expect(report.problems.join(" ")).toMatch(/over 60 words/u);
  });

  it("requires quizzes in explainers but not in dashboards", () => {
    const sections = "<section><h2>A</h2><svg></svg></section>".repeat(6);
    expect(checkContentGuidelines(`<title>Onboarding guide</title>${sections}`).problems.join(" "))
      .toMatch(/quiz/u);
    expect(checkContentGuidelines(`<title>Deploy dashboard</title>${sections}`).problems).toEqual([]);
  });

  it("ignores scripts and styles when counting prose", () => {
    const html = `<svg></svg><script>const s = "${wall}";</script><p>ok</p>`;
    expect(checkContentGuidelines(html).problems).toEqual([]);
  });
});
