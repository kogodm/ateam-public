/** What Claude returns for an AskUserQuestion, cut back into one answer per
 *  question. The tool_result is one blob —
 *
 *    The user answered: "Q1"="A1", "Q2"="A2". Read the answers carefully — …
 *
 *  — with the questions' own quotes left unescaped, so the pairs cannot be
 *  found by matching quotes: each question is looked for by its exact text. */

const BOILERPLATE_HEAD = /^\s*(?:Your questions have been answered:|The user answered:)\s*/i;
const BOILERPLATE_TAIL = /\.?\s*(?:Read the answers carefully|You can now continue)[\s\S]*$/i;

/** the answer text with Claude's framing taken off */
export function cleanAnswer(text: string): string {
  return text.replace(BOILERPLATE_HEAD, '').replace(BOILERPLATE_TAIL, '').trim();
}

/** one answer per question, or null when the text does not follow the form */
export function splitAnswers(
  text: string,
  questions: readonly { question: string }[],
): string[] | null {
  const body = cleanAnswer(text);
  const marks = questions.map((q) => body.indexOf(`"${q.question}"=`));
  if (marks.length === 0 || marks.some((m) => m < 0)) return null;
  // the pairs come in the order asked; a different order cannot be cut safely
  if (marks.some((m, i) => i > 0 && m <= (marks[i - 1] ?? -1))) return null;
  return questions.map((q, i) => {
    const start = (marks[i] ?? 0) + `"${q.question}"=`.length;
    const end = marks[i + 1] ?? body.length;
    return body
      .slice(start, end)
      .replace(/,\s*$/, '')
      .replace(/^"([\s\S]*)"$/, '$1')
      .trim();
  });
}
