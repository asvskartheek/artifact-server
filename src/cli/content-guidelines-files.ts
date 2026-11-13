import {readFile, stat} from "node:fs/promises";
import path from "node:path";

import {checkContentGuidelines} from "./content-guidelines.js";

/** Guideline problems for the HTML page a publish would open first; [] for non-HTML. */
export async function checkHtmlEntryGuidelines(
  inputPath: string,
  entry: string | undefined,
): Promise<readonly string[]> {
  const isDirectory = (await stat(inputPath)).isDirectory();
  const entryFile = isDirectory ? path.join(inputPath, entry ?? "index.html") : inputPath;
  if (!/\.html?$/iu.test(entryFile)) return [];
  const html = await readFile(entryFile, "utf8").catch(() => null);
  return html === null ? [] : checkContentGuidelines(html).problems;
}
