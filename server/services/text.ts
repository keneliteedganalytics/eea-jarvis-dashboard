// Small grammar helpers for spoken-brief copy so count-nouns and verbs agree.
// Kept dependency-free and pure so they're trivial to unit-test and snapshot.

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

// Spell out small integers — reads better via TTS (English convention).
export function numberWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 9 ? WORDS[n] : String(n);
}

// "one sniper" / "three snipers". Uses numberWord for n <= 9.
export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${numberWord(n)} ${n === 1 ? singular : plural}`;
}

export function isAre(n: number): string {
  return n === 1 ? "is" : "are";
}

export function thereIsAre(n: number): string {
  return n === 1 ? "there is" : "there are";
}
