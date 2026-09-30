/**
 * Normalization utilities for Keyword Finder.
 * Handles casing, punctuation, singular/plural, stop-words, and canonization.
 */

// Common stop words that don't alter core topic meaning when comparing keywords
const COMPARISON_STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'in', 'on', 'with', 'to', 'from', 'at', 'by', 'into', 'onto'
]);

// Plural to singular rules for financial, crypto, and tech keywords
const PLURAL_MAP = {
  'cards': 'card',
  'accounts': 'account',
  'stocks': 'stock',
  'coins': 'coin',
  'wallets': 'wallet',
  'fees': 'fee',
  'methods': 'method',
  'apps': 'app',
  'videos': 'video',
  'emails': 'email',
  'numbers': 'number',
  'limits': 'limit',
  'banks': 'bank',
  'transactions': 'transaction',
  'deposits': 'deposit',
  'withdrawals': 'withdrawal',
  'options': 'option',
  'funds': 'fund',
  'payments': 'payment',
  'transfers': 'transfer',
  'tokens': 'token',
  'cryptos': 'crypto',
  'features': 'feature',
  'devices': 'device',
  'settings': 'setting',
  'notifications': 'notification',
  'keys': 'key',
  'codes': 'code',
  'guides': 'guide',
  'tutorials': 'tutorial',
  'steps': 'step'
};

/**
 * Standardize text: lowercase, remove special characters, trim, collapse whitespace.
 */
export function cleanText(text = '') {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s$]/g, ' ') // keep alphanumerics, underscores, whitespace, dollar signs
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stem a single token (singularize known nouns).
 */
export function stemToken(token) {
  if (!token) return '';
  const lower = token.toLowerCase();
  if (PLURAL_MAP[lower]) return PLURAL_MAP[lower];
  
  // General fallback for English plurals: ending in 's' but not 'ss' / 'us' / 'is'
  if (lower.length > 3 && lower.endsWith('s') && !lower.endsWith('ss') && !lower.endsWith('us') && !lower.endsWith('is')) {
    if (lower.endsWith('ies') && lower.length > 4) {
      return lower.slice(0, -3) + 'y';
    }
    return lower.slice(0, -1);
  }
  return lower;
}

/**
 * Break text into array of cleaned and stemmed tokens.
 * @param {string} text 
 * @param {boolean} removeStopWords - whether to filter out comparison stop words
 */
export function tokenize(text = '', removeStopWords = false) {
  const cleaned = cleanText(text);
  if (!cleaned) return [];
  const words = cleaned.split(' ');
  const result = [];
  
  for (const word of words) {
    if (!word) continue;
    const stemmed = stemToken(word);
    if (removeStopWords && COMPARISON_STOP_WORDS.has(stemmed)) {
      continue;
    }
    result.push(stemmed);
  }
  return result;
}

/**
 * Generate a canonical comparison key for a keyword.
 * Example: "How To Add A Debit Card To Robinhood" -> "how add card robinhood"
 * This ensures matching representations regardless of casing, punctuation, 'a/an/the', and pluralization.
 */
export function canonicalKey(text = '') {
  const tokens = tokenize(text, true); // remove stop words
  return tokens.join(' ');
}

// Boilerplate phrases commonly appended to YouTube video titles that are not
// part of the actual topic (e.g. "How to X on Y (Full Guide)").
const BOILERPLATE_PHRASES = [
  'full guide', 'fully explained', 'complete guide', 'step by step',
  'easy tutorial', 'video tutorial', 'explained'
];

/**
 * Topic comparison key: like canonicalKey but strips title boilerplate,
 * so a keyword "how to add bank account in razor pay" matches the video
 * title "How to Add Bank Account in Razor Pay (Full Guide)".
 */
export function topicKey(text = '') {
  let cleaned = cleanText(text);
  for (const phrase of BOILERPLATE_PHRASES) {
    cleaned = cleaned.split(phrase).join(' ');
  }
  return tokenize(cleaned, true).join(' ');
}

/**
 * Normalized keyword representation preserving structural words for display or exact match.
 */
export function normalizeKeyword(text = '') {
  return cleanText(text);
}

/**
 * Calculate Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a = '', b = '') {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const row = [];
  for (let i = 0; i <= b.length; i++) {
    row[i] = i;
  }

  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      let val;
      if (a[i - 1] === b[j - 1]) {
        val = row[j - 1];
      } else {
        val = Math.min(row[j - 1] + 1, Math.min(prev + 1, row[j] + 1));
      }
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }

  return row[b.length];
}

/**
 * Normalized string similarity ratio (0.0 to 1.0).
 */
export function stringSimilarity(str1 = '', str2 = '') {
  const s1 = cleanText(str1);
  const s2 = cleanText(str2);
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;
  const maxLen = Math.max(s1.length, s2.length);
  const dist = levenshteinDistance(s1, s2);
  return Math.max(0, 1 - dist / maxLen);
}
