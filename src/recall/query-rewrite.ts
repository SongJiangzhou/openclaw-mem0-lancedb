import { deriveRecallSizing } from './sizing';

const MAX_QUERY_VARIANTS = deriveRecallSizing(1).maxQueryVariants;

export type RecallQueryVariantKind = 'original' | 'compressed';

export interface RecallQueryVariant {
  text: string;
  kind: RecallQueryVariantKind;
  weight: number;
}

export function buildRecallQueryVariants(query: string): RecallQueryVariant[] {
  const original = extractRecallQueryBody(query);
  if (!original) {
    return [];
  }

  const variants: RecallQueryVariant[] = [{ text: original, kind: 'original', weight: 1 }];
  const segments = collectCandidateSegments(original);

  const compressed = segments[0];
  if (compressed && compressed !== original) {
    variants.push({ text: compressed, kind: 'compressed', weight: 1.15 });
  }

  return variants.slice(0, MAX_QUERY_VARIANTS);
}

function collectCandidateSegments(query: string): string[] {
  const segments = new Map<string, number>();
  const sentenceParts = query
    .split(/[\r\n]+|(?<=[.?!。！？])\s+/u)
    .map((part) => normalizeQueryVariant(part))
    .filter(Boolean);

  sentenceParts.forEach((part) => {
    segments.set(part, Math.max(scoreSegment(part), segments.get(part) ?? Number.NEGATIVE_INFINITY));
    splitClauses(part).forEach((clause) => {
      segments.set(clause, Math.max(scoreSegment(clause), segments.get(clause) ?? Number.NEGATIVE_INFINITY));
    });
  });

  return [...segments.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].length - right[0].length)
    .map(([text]) => text);
}

function splitClauses(text: string): string[] {
  return text
    .split(/[,:;，、；：]\s*/u)
    .map((part) => normalizeQueryVariant(part))
    .filter((part) => part.length >= 8);
}

function scoreSegment(text: string): number {
  const length = text.length;
  const hasQuestion = /[?？]/u.test(text) ? 2 : 0;
  const hasOperationalNoise = /\/|\\|\.jsonl\b|workspace|scripts\/|openclaw\.json/i.test(text) ? -4 : 0;
  const targetLength = length >= 12 && length <= 96 ? 2 : length <= 140 ? 1 : -1;
  const punctuationPenalty = /[*_#>|`]/u.test(text) ? -2 : 0;
  const characterDensity = countAlphaNumericOrCjk(text) / Math.max(length, 1);

  return hasQuestion + hasOperationalNoise + targetLength + punctuationPenalty + characterDensity;
}

function extractRecallQueryBody(value: string): string {
  const raw = String(value || '');
  const withoutCodeBlocks = raw.replace(/```[\s\S]*?```/gu, ' ');
  const senderPrefix = new RegExp(String.raw`^sender\s*\(untrusted metadata\)\s*:\s*`, 'iu');
  const timestampPrefix = new RegExp(String.raw`^\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}.*?GMT[+-]\d+\]\s*`, 'u');
  const lines = withoutCodeBlocks
    .split(/\r?\n/u)
    .map((line) =>
      line
        .replace(senderPrefix, '')
        .replace(timestampPrefix, '')
        .trim(),
    )
    .filter(Boolean)
    .filter((line) => !/^[{\[]/.test(line))
    .filter((line) => !/^(label|id|name|username|sender|timestamp|message_id|sender_id)\s*:/iu.test(line));

  const joined = normalizeQueryVariant(lines.join(' '));
  return joined || normalizeQueryVariant(raw);
}

function normalizeQueryVariant(value: string): string {
  return String(value || '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

function countAlphaNumericOrCjk(value: string): number {
  const matches = value.match(/[\p{L}\p{N}\p{Script=Han}]/gu);
  return matches?.length ?? 0;
}
