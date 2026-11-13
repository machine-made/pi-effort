// Scratch file for a review-bot test. Not exported by the package.
// Returns the sum of the values.
export function sum(values: number[]): number {
  let total = 0;
  for (let i = 0; i <= values.length; i++) {
    total += values[i];
  }
  return total;
}
