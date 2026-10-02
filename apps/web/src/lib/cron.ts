// Routines run on cron expressions in UTC, but people think in their own time. These turn a cron into words
// ("Every day at 2:31 AM and 2:31 PM") and a schedule picked in local time into a cron, when one cron can say it.

export type Frequency = 'daily' | 'weekdays' | 'weekends' | 'days' | 'hours' | 'minutes' | 'custom';

export interface SimpleSchedule {
  frequency: Frequency;
  /** Local times as "HH:MM" (daily, weekdays, weekends, days). */
  times: string[];
  /** Local days, 0 = Sunday (days). */
  days: number[];
  /** Every this many hours or minutes. */
  every: number;
  /** The expression itself (custom). */
  cron: string;
}

export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKENDS = [0, 6];

/** Minutes to add to a local time to get UTC (Date's offset, at today's daylight saving). */
const offset = () => new Date().getTimezoneOffset();
const pad = (n: number) => String(n).padStart(2, '0');
const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((x) => b.includes(x));
const shiftDays = (days: number[], by: number) => [...new Set(days.map((d) => (((d + by) % 7) + 7) % 7))].sort((a, b) => a - b);

/** A cron field of plain numbers, lists and ranges; null for "*", undefined when it uses anything else. */
function expand(field: string, min: number, max: number): number[] | null | undefined {
  if (field === '*') return null;
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const range = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!range) return undefined;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from < min || to > max || from > to) return undefined;
    for (let n = from; n <= to; n++) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** "1,2,3,4,5" → "1-5"; other lists stay lists. */
function compress(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const contiguous = sorted.length > 2 && sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  return contiguous ? `${sorted[0]}-${sorted.at(-1)}` : sorted.join(',');
}

const blank = (cron: string): SimpleSchedule => ({ frequency: 'custom', times: ['09:00'], days: [1], every: 1, cron });

export function fromCron(cron: string): SimpleSchedule {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return blank(cron);
  const [min, hour, dom, month, dow] = f;
  if (dom !== '*' || month !== '*') return blank(cron);
  const step = (s: string) => s.match(/^\*\/(\d+)$/)?.[1];
  if (step(min) && hour === '*' && dow === '*') return { ...blank(cron), frequency: 'minutes', every: Number(step(min)) };
  if (min === '0' && step(hour) && dow === '*') return { ...blank(cron), frequency: 'hours', every: Number(step(hour)) };
  if (min === '0' && hour === '*' && dow === '*') return { ...blank(cron), frequency: 'hours', every: 1 };
  if (!/^\d+$/.test(min)) return blank(cron);
  const hours = expand(hour, 0, 23);
  const utcDays = expand(dow.replace(/\b7\b/g, '0'), 0, 6);
  if (!hours || utcDays === undefined) return blank(cron);
  // Each UTC time as a local time, and how many days it moved.
  const local = hours.map((h) => {
    const total = h * 60 + Number(min) - offset();
    const inDay = ((total % 1440) + 1440) % 1440;
    return { time: `${pad(Math.floor(inDay / 60))}:${pad(inDay % 60)}`, shift: Math.floor(total / 1440) };
  });
  const times = local.map((l) => l.time).sort();
  if (utcDays === null) return { ...blank(cron), frequency: 'daily', times };
  if (local.some((l) => l.shift !== local[0].shift)) return blank(cron);
  const days = shiftDays(utcDays, local[0].shift);
  const frequency = sameSet(days, WEEKDAYS) ? 'weekdays' : sameSet(days, WEEKENDS) ? 'weekends' : days.length === 7 ? 'daily' : 'days';
  return { ...blank(cron), frequency, times, days };
}

/** The cron for a schedule, or an error when one cron can't express it. */
export function toCron(s: SimpleSchedule): { cron: string } | { error: string } {
  if (s.frequency === 'custom') return s.cron.trim() ? { cron: s.cron.trim() } : { error: 'Write a cron expression' };
  if (s.frequency === 'minutes') return { cron: s.every <= 1 ? '* * * * *' : `*/${s.every} * * * *` };
  if (s.frequency === 'hours') return { cron: s.every <= 1 ? '0 * * * *' : `0 */${s.every} * * *` };
  const times = [...new Set(s.times.filter((t) => /^\d{2}:\d{2}$/.test(t)))];
  if (!times.length) return { error: 'Add a time' };
  const utc = times.map((t) => {
    const [h, m] = t.split(':').map(Number);
    const total = h * 60 + m + offset();
    const inDay = ((total % 1440) + 1440) % 1440;
    return { hour: Math.floor(inDay / 60), minute: inDay % 60, shift: Math.floor(total / 1440) };
  });
  if (utc.some((u) => u.minute !== utc[0].minute)) return { error: 'All times need the same minutes past the hour (e.g. 9:30 and 17:30)' };
  const hours = [...new Set(utc.map((u) => u.hour))].sort((a, b) => a - b).join(',');
  if (s.frequency === 'daily') return { cron: `${utc[0].minute} ${hours} * * *` };
  const localDays = s.frequency === 'weekdays' ? WEEKDAYS : s.frequency === 'weekends' ? WEEKENDS : s.days;
  if (!localDays.length) return { error: 'Pick at least one day' };
  if (utc.some((u) => u.shift !== utc[0].shift)) return { error: 'In UTC these times fall on different days. Use “Every day”, or make two routines.' };
  return { cron: `${utc[0].minute} ${hours} * * ${compress(shiftDays(localDays, utc[0].shift))}` };
}

export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function listWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export function describeSchedule(s: SimpleSchedule): string {
  const at = `at ${listWords(s.times.map(formatTime))}`;
  switch (s.frequency) {
    case 'minutes':
      return s.every <= 1 ? 'Every minute' : `Every ${s.every} minutes`;
    case 'hours':
      return s.every <= 1 ? 'Every hour' : `Every ${s.every} hours`;
    case 'daily':
      return `Every day ${at}`;
    case 'weekdays':
      return `Weekdays ${at}`;
    case 'weekends':
      return `Weekends ${at}`;
    case 'days':
      return s.days.length === 1 ? `Every ${DAY_LONG[s.days[0]]} ${at}` : `${listWords(s.days.map((d) => DAY_SHORT[d]))} ${at}`;
    case 'custom':
      return `Cron ${s.cron} (UTC)`;
  }
}

export const describeCron = (cron: string) => describeSchedule(fromCron(cron));
