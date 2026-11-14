export function historyTimestamp(value: unknown): number {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))) {
    const number = Number(value); return number < 1e12 ? number * 1000 : number;
  }
  if (typeof value !== 'string') return 0;
  const time = Date.parse(/^\d{4}-\d\d-\d\d \d\d:/.test(value) && !/[Z+-]\d*:?\d*$/.test(value.slice(10)) ? value.replace(' ', 'T') + 'Z' : value);
  return Number.isFinite(time) ? time : 0;
}
