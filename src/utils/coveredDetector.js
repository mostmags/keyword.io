/**
 * Covered Keyword Detection & Opportunity Engine for Keyword Finder.
 *
 * Coverage semantics (strict, per user requirement):
 *  - 'covered_channel'  : the channel has a video whose title matches the
 *    keyword (same words, ignoring casing, punctuation, stop-words,
 *    plurals, and "(Full Guide)"-style boilerplate). Similar-but-different
 *    topics are NEVER treated as covered.
 *  - 'covered_ranking'  : no matching title exists, but one of the channel's
 *    videos ranks #1 or #2 in YouTube search for the keyword — the traffic
 *    for that exact topic is already captured.
 *  - 'unique'           : neither of the above.
 */

import { canonicalKey, topicKey } from './normalizer.js';

export const DEFAULT_RANK_THRESHOLDS = {
  coveredMaxRank: 2 // Only rank 1-2 count as covered
};

/**
 * Human-readable label for status/category
 */
export function getStatusLabel(category = '') {
  switch (category) {
    case 'covered_channel':
    case 'covered':
      return 'Covered';
    case 'covered_ranking':
      return 'Covered (Top 2)';
    case 'unique':
    default:
      return 'Unique Opportunity';
  }
}

/**
 * Evaluates whether a keyword is covered by an existing channel video with
 * the same title, or by a top-2 channel ranking in YouTube search results.
 *
 * @param {string} keyword - Candidate keyword
 * @param {Object} channelIndex - Preprocessed channel index
 * @param {Object|null} channelRank - YouTube search ranking for channel: { position, videoId, title }
 * @param {Object} config - Configurable rank thresholds (default max rank = 2)
 * @returns {Object} Deterministic 3-category evaluation
 */
export function evaluateCoverage(keyword = '', channelIndex = null, channelRank = null, config = DEFAULT_RANK_THRESHOLDS) {
  const kwCanonical = canonicalKey(keyword);
  const kwTopic = topicKey(keyword);
  const reasons = [];

  // =========================================================================
  // STEP 1: Exact title match against the channel video library
  // =========================================================================
  let isCoveredByChannel = false;
  let bestMatchedVideo = null;

  if (channelIndex && channelIndex.indexedVideos && channelIndex.indexedVideos.length > 0) {
    // Instant lookup via canonical map (built at index time)
    if (channelIndex.exactCanonicalMap.has(kwCanonical)) {
      isCoveredByChannel = true;
      bestMatchedVideo = channelIndex.indexedVideos[channelIndex.exactCanonicalMap.get(kwCanonical)];
    } else {
      // Fallback: compare topic keys (canonical minus "(Full Guide)" boilerplate)
      for (const video of channelIndex.indexedVideos) {
        if (video.topicKey === kwTopic) {
          isCoveredByChannel = true;
          bestMatchedVideo = video;
          break;
        }
      }
    }

    if (isCoveredByChannel) {
      reasons.push(`Covered by existing video: "${bestMatchedVideo.rawTitle}"`);
    }
  }

  // =========================================================================
  // STEP 2: Evaluate Channel Search Ranking (Only if not covered by title)
  // =========================================================================
  let isCoveredByRank = false;
  const maxCoveredRank = config.coveredMaxRank || 2;

  if (!isCoveredByChannel && channelRank && typeof channelRank.position === 'number' && channelRank.position > 0) {
    if (channelRank.position <= maxCoveredRank) {
      isCoveredByRank = true;
      reasons.push(`Channel ranks #${channelRank.position} on YouTube: "${channelRank.title}"`);
      reasons.push('Already capturing top search traffic — no new video needed');
    } else {
      // Channel ranks #3 or worse: NOT covered, but recorded as context
      reasons.push(`Channel ranks #${channelRank.position} (outside top 2): "${channelRank.title}"`);
      reasons.push('Opportunity to target and capture the #1 position');
    }
  }

  // =========================================================================
  // STEP 3: Assign Final Category
  // =========================================================================
  let category = 'unique';
  let status = 'unique';

  if (isCoveredByChannel) {
    category = 'covered_channel';
    status = 'covered';
  } else if (isCoveredByRank) {
    category = 'covered_ranking';
    status = 'covered';
  } else {
    category = 'unique';
    status = 'unique';
    reasons.length = 0;
    reasons.push('Untapped opportunity: No video with this title and not ranking in top 2');
  }

  return {
    keyword,
    category,                       // 'covered_channel' | 'covered_ranking' | 'unique'
    status,                         // 'covered' | 'unique'
    isCovered: status === 'covered',
    isCoveredByChannel,
    isCoveredByRank,
    isUnique: status === 'unique',
    coveredScore: isCoveredByChannel ? 100 : (isCoveredByRank ? 95 : 0),
    matchedVideo: isCoveredByChannel && bestMatchedVideo ? { id: bestMatchedVideo.id, title: bestMatchedVideo.rawTitle } : null,
    channelRank: channelRank || null,
    reasons
  };
}

/**
 * Opportunity classification without displaying misleading percentages.
 */
export function calculateOpportunityScore(relevanceScore = 50, coveredScore = 0, hasChannelRank = false) {
  if (coveredScore >= 70 || hasChannelRank) return 0;
  return Math.min(100, Math.max(0, Math.round(relevanceScore)));
}
