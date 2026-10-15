// Hebrew year label for a Gregorian academic year, e.g. 2027 -> תשפ"ז
const ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
const TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
const HUNDREDS = ['', 'ק', 'ר', 'ש', 'ת', 'תק', 'תר', 'תש', 'תת', 'תתק'];

export function hebrewYear(gregorian) {
  let n = (gregorian + 3760) % 1000;
  let s = HUNDREDS[Math.floor(n / 100)];
  n %= 100;
  if (n === 15) s += 'טו';
  else if (n === 16) s += 'טז';
  else s += TENS[Math.floor(n / 10)] + ONES[n % 10];
  if (s.length === 1) return s + "'";
  return s.slice(0, -1) + '"' + s.slice(-1);
}

export const YEAR_ORDINAL_HE = ["א'", "ב'", "ג'", "ד'", "ה'", "ו'", "ז'", "ח'", "ט'", "י'", 'י"א', 'י"ב'];
