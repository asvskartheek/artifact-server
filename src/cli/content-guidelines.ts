/**
 * Studio content guidelines, checked before an HTML artifact is published.
 * See skills/artifact-server/references/content-guidelines.md.
 *
 * shortcut: a tag-and-text scan, not a full HTML parser; it judges authored
 * markup, so pages that render everything from JS are judged by their widgets
 * and quizzes markers alone. Upgrade to a real DOM pass if rules get subtler.
 */

/** Words before one paragraph or list item counts as a wall of text. */
export const maximumBlockWords = 60;
/** Share of all visible words allowed in paragraph/list prose. */
export const maximumProseShare = 0.6;

const visualOrWidget = new RegExp(
  [
    "<svg\\b", "<canvas\\b", "<input\\b", "<button\\b", "<details\\b", "<select\\b",
    "<textarea\\b", "<video\\b", "<img\\b", "class=\"[^\"]*\\bmermaid\\b",
    "\\bnew Chart\\(", "@radix-ui/", "\\bdata-quiz\\b", "role=\"(tab|slider|switch|button)\"",
  ].join("|"),
  "iu",
);

const explainerSignal =
  /\b(onboarding|explainer|walkthrough|tutorial|how it works|how .{1,30} works|guide|introduction|understand|learn)\b/iu;

export interface GuidelineReport {
  readonly problems: readonly string[];
}

function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|svg|template|noscript)\b[\s\S]*?<\/\1>/giu, " ");
}

function textOf(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/gu, " ")
    .replace(/&[a-z#0-9]+;/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function words(text: string): number {
  return text === "" ? 0 : text.split(" ").length;
}

/** Check one HTML document; an empty problem list means it may publish. */
export function checkContentGuidelines(html: string): GuidelineReport {
  const problems: string[] = [];
  const content = stripNonContent(html);

  if (!visualOrWidget.test(html)) {
    problems.push(
      "No visual or interactive element. Add a diagram (<svg>/Mermaid), a chart, or a widget (tabs, slider, toggle, quiz).",
    );
  }

  const blocks = [...content.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/giu)]
    .map((match) => textOf(match[2] ?? ""));
  const longBlocks = blocks.filter((text) => words(text) > maximumBlockWords);
  if (longBlocks.length > 0) {
    const sample = (longBlocks[0] ?? "").slice(0, 60);
    problems.push(
      `${longBlocks.length} block(s) over ${maximumBlockWords} words (first: "${sample}…"). Split into cards, steps, a table or a diagram.`,
    );
  }

  const totalWords = words(textOf(content));
  const proseWords = blocks.reduce((sum, text) => sum + words(text), 0);
  if (totalWords > 150 && proseWords / totalWords > maximumProseShare) {
    problems.push(
      `Prose is ${Math.round((proseWords / totalWords) * 100)}% of the text (limit ${maximumProseShare * 100}%). Turn paragraphs into visuals.`,
    );
  }

  const title = textOf(/<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1] ?? "");
  const headings = [...content.matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/giu)]
    .map((match) => textOf(match[1] ?? ""))
    .join(" ");
  const isExplainer = explainerSignal.test(`${title} ${headings}`);
  const quizzes = (html.match(/\bdata-quiz\b/giu) ?? []).length;
  const sections = Math.max(1, (content.match(/<(section|h2)\b/giu) ?? []).length);
  if (isExplainer && quizzes < Math.max(1, Math.floor(sections / 3))) {
    problems.push(
      `Explainer with ${sections} section(s) but ${quizzes} quiz(zes). Add a tiny quiz (data-quiz) after every 2–3 sections.`,
    );
  }

  return {problems};
}
