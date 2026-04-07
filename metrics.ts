export interface Stats {
  median: number;
  p75: number;
  p90: number;
  count: number;
}

export function computeStats(values: number[]): Stats {
  if (values.length === 0) {
    return { median: 0, p75: 0, p90: 0, count: 0 };
  }

  const sorted = values.toSorted((numA, numB) => numA - numB);
  const count = sorted.length;

  const midIndex = Math.floor(count / 2);
  const median = count % 2 === 1
    ? sorted[midIndex]
    : (sorted[midIndex - 1] + sorted[midIndex]) / 2;

  const p75Index = Math.floor((count - 1) * 0.75);
  const p75 = sorted[p75Index];
  const p90Index = Math.floor((count - 1) * 0.9);
  const p90 = sorted[p90Index];

  return { median, p75, p90, count };
}
