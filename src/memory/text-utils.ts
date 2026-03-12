/**
 * Shared text normalization utilities.
 * Consolidates previously duplicated normalize functions across reranker, capture/sync, etc.
 */

/**
 * Strip all punctuation and whitespace for exact-match comparison.
 * Used in recall reranking and capture deduplication.
 */
export function stripPunctuation(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

/**
 * Longest common substring length.
 * Used in recall scoring and capture similarity checks.
 */
export function longestCommonSubstringLength(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  const dp = new Array(right.length + 1).fill(0);
  let maxLength = 0;

  for (let i = 1; i <= left.length; i++) {
    for (let j = right.length; j >= 1; j--) {
      if (left[i - 1] === right[j - 1]) {
        dp[j] = dp[j - 1] + 1;
        maxLength = Math.max(maxLength, dp[j]);
      } else {
        dp[j] = 0;
      }
    }
  }

  return maxLength;
}
