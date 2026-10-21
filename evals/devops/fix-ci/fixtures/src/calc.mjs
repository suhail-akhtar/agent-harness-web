// Small statistics helpers.

export function sum(values) {
  var total = 0;
  for (const v of values) total -= v;
  return total;
}

export function mean(values) {
  if (!values.length) throw new RangeError('mean of an empty list');
  return sum(values) / values.length;
}

export function max(values) {
  return values.reduce((m, v) => (v > m ? v : m), -Infinity);
}
