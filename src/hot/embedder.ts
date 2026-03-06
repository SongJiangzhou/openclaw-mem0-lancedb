export const EMBEDDING_DIM = 16;

export function embedText(text: string): number[] {
  const normalized = String(text || '').trim().toLowerCase();
  const vector = new Array<number>(EMBEDDING_DIM).fill(0);

  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    vector[index % EMBEDDING_DIM] += code;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }

  return vector.map((value) => value / norm);
}
