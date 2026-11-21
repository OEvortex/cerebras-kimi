const PRIMARY_READING_ACTIONS = [
  "read_aloud:read",
  "vocabulary:explain",
  "quiz:start",
] as const;

export function primaryReadingActionRank(key: string): number {
  return PRIMARY_READING_ACTIONS.findIndex((candidate) => candidate === key);
}
