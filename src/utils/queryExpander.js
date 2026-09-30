/**
 * Query Expansion and Keyword Discovery Engine for Keyword Finder.
 * Expands search queries across action, preposition, question, and word-order dimensions
 * to maximize relevant recall while strictly pruning low-relevance noise.
 */

import { cleanText, canonicalKey } from './normalizer.js';
import { extractIntent } from './intentExtractor.js';
import { rankKeywords } from './relevanceRanker.js';

// Preposition variations to explore
const PREPOSITIONS = ['on', 'in', 'to', 'from', 'with', 'through', 'using', 'into', 'by'];

/**
 * Generate natural query variants for Google Suggest completion.
 * Discovers authentic question forms, preposition swaps, and cleaned typo variants,
 * strictly avoiding artificial modifier concatenation.
 * @param {string} text - User query
 * @param {number} cursorPos - Cursor position
 * @returns {Array<{ q: string, cp: number }>} Array of query objects
 */
export function generateQueryVariations(text = '', cursorPos = 0) {
  const cleaned = cleanText(text);
  if (!cleaned) return [];

  const queries = [];
  const seenQueries = new Set();

  function addQuery(q, cp) {
    const trimmed = q.trim();
    if (trimmed && !seenQueries.has(trimmed)) {
      seenQueries.add(trimmed);
      queries.push({ q: trimmed, cp: cp || trimmed.length });
    }
  }

  // 1. Primary query at current cursor position (YouTube natively autocompletes cursor position via cp)
  addQuery(text, cursorPos);

  // 2. Dangling single-character / typo normalization
  // If query contains a standalone single letter token (e.g. "how to add b botim"), also query the clean version
  const hasDanglingSingle = /\b([b-hj-z0-9])\b/i.test(cleaned);
  if (hasDanglingSingle) {
    const normalized = cleaned.replace(/\b([b-hj-z0-9])\b\s*/gi, '').replace(/\s+/g, ' ').trim();
    if (normalized && normalized !== cleaned) {
      addQuery(normalized, normalized.length);
    }
  }

  // Only explore linguistic variations if words are complete (no mid-typing dangling letters)
  const tokens = cleaned.split(' ');
  const isComplete = !hasDanglingSingle && tokens.length >= 2;

  if (isComplete) {
    // 3. Question Form Variations
    if (cleaned.startsWith('how to ')) {
      const rest = cleaned.substring(7);
      addQuery(`how do i ${rest}`);
      addQuery(`how can i ${rest}`);
    } else if (cleaned.startsWith('how do i ')) {
      const rest = cleaned.substring(9);
      addQuery(`how to ${rest}`);
      addQuery(`how can i ${rest}`);
    } else if (!cleaned.startsWith('how') && !cleaned.startsWith('can') && !cleaned.startsWith('why') && !cleaned.startsWith('where')) {
      addQuery(`how to ${cleaned}`);
    }

    // 4. Preposition Variations (strictly skip "to" in infinitive "how to" or "where to")
    const searchStart = cleaned.startsWith('how to ') ? 7 : (cleaned.startsWith('where to ') ? 9 : 0);
    const sub = cleaned.substring(searchStart);
    const prepRegex = /\s+(on|in|to|from|with|through|using|into|by)\s+/i;
    const prepMatch = sub.match(prepRegex);
    if (prepMatch) {
      const currentPrep = prepMatch[1].toLowerCase();
      const altPreps = PREPOSITIONS.filter(p => p !== currentPrep).slice(0, 2);
      for (const alt of altPreps) {
        const altSub = sub.replace(prepRegex, ` ${alt} `);
        const altQuery = (cleaned.substring(0, searchStart) + altSub).replace(/\s+/g, ' ').trim();
        addQuery(altQuery);
      }
    }

    // 5. Word Order Variations (Platform first vs Action first)
    const intent = extractIntent(cleaned);
    if (intent.platform && intent.action && cleaned.startsWith('how to')) {
      addQuery(`${intent.platform} ${cleaned}`);
    }
  }

  // Return natural query variants
  return queries.slice(0, 15);
}

/**
 * Filter and rank discovered keyword suggestions.
 * Enforces minimum quality/relevance threshold so irrelevant results are pruned,
 * while preserving rich long-tail keywords.
 * @param {string} originalQuery
 * @param {Array<string>} suggestions
 * @param {number} minRelevance - Minimum relevance threshold (default: 15)
 * @param {number} maxResults - Maximum results to return (default: 60)
 * @returns {Array<string>} High-relevance deduplicated keyword suggestions
 */
export function filterAndRankSuggestions(originalQuery = '', suggestions = [], minRelevance = 15, maxResults = 60) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return [];
  if (!originalQuery || !originalQuery.trim()) return suggestions.slice(0, maxResults);

  // Deduplicate by canonical representation while keeping first occurrence
  const seenCanonical = new Set();
  const uniqueCandidates = [];

  for (const candidate of suggestions) {
    if (!candidate || typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    
    const canonical = canonicalKey(trimmed);
    if (!seenCanonical.has(canonical)) {
      seenCanonical.add(canonical);
      uniqueCandidates.push(trimmed);
    }
  }

  // Rank against original query
  const ranked = rankKeywords(originalQuery, uniqueCandidates);

  // Filter out completely irrelevant noise below threshold
  const filtered = ranked.filter(item => item.relevanceScore >= minRelevance);

  return filtered.slice(0, maxResults).map(item => item.keyword);
}
