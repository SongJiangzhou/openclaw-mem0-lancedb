export interface RecallSizingPolicy {
  injectTopK: number;
  candidateTopK: number;
  primaryFetchK: number;
  secondaryFetchK: number;
  maxQueryVariants: number;
}

export function deriveRecallSizing(topK: number): RecallSizingPolicy {
  const injectTopK = Math.max(1, topK);
  const candidateTopK = Math.max(injectTopK * 2, 12);

  return {
    injectTopK,
    candidateTopK,
    primaryFetchK: Math.max(candidateTopK * 6, 24),
    secondaryFetchK: Math.max(candidateTopK * 4, 16),
    maxQueryVariants: 3,
  };
}
