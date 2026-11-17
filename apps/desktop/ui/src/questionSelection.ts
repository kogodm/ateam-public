/** Whether any option in one AskUserQuestion has been selected. */
export function hasAnswerForQuestion(picked: ReadonlySet<string>, qi: number): boolean {
  const prefix = `${qi}:`;
  for (const key of picked) if (key.startsWith(prefix)) return true;
  return false;
}
