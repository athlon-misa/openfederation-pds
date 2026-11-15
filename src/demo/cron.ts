/**
 * A five-field cron expression (minute hour day-of-month month day-of-week),
 * always read in UTC. Enough for the demo reset schedule (DEMO_RESET_SCHEDULE):
 * `*`, numbers, lists (`1,15`), ranges (`1-5`) and steps (`*\/15`, `0-30/10`).
 * Day-of-week 0 and 7 are both Sunday. As in every cron, when both day fields
 * are restricted a day matching either one runs.
 *
 * Anything else (names, `@daily`, six fields) is refused: a schedule that
 * decides when everything is deleted must not be guessed at.
 *
 * plc-server/demo-reset.js carries the same rules for the PLC directory,
 * which is deployed on its own and cannot import this file.
 */
export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
] as const;

function parseField(raw: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  const num = (s: string) => {
    if (!/^\d+$/.test(s)) throw new Error(`"${s}" is not a number in the ${name} field`);
    const n = parseInt(s, 10);
    if (n < min || n > max) throw new Error(`${n} is outside ${min}-${max} in the ${name} field`);
    return n;
  };
  for (const part of raw.split(',')) {
    const [range, stepRaw, extra] = part.split('/');
    if (extra !== undefined || range === '') throw new Error(`"${part}" is not valid in the ${name} field`);
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || parseInt(stepRaw, 10) < 1) throw new Error(`"${part}" has an invalid step in the ${name} field`);
      step = parseInt(stepRaw, 10);
    }
    let lo: number;
    let hi: number;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined) throw new Error(`"${part}" is not valid in the ${name} field`);
      lo = num(a); hi = num(b);
      if (lo > hi) throw new Error(`"${part}" runs backwards in the ${name} field`);
    } else {
      lo = num(range);
      hi = stepRaw !== undefined ? max : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSchedule {
  const parts = expr.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new Error(`a cron expression has five fields (minute hour day-of-month month day-of-week), got "${expr}"`);
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parts.map((p, i) => parseField(p, FIELDS[i].min, FIELDS[i].max, FIELDS[i].name));
  if (daysOfWeek.has(7)) { daysOfWeek.delete(7); daysOfWeek.add(0); }
  return {
    minutes, hours, daysOfMonth, months, daysOfWeek,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

function dayMatches(s: CronSchedule, d: Date): boolean {
  const dom = s.daysOfMonth.has(d.getUTCDate());
  const dow = s.daysOfWeek.has(d.getUTCDay());
  if (s.domRestricted && s.dowRestricted) return dom || dow;
  if (s.domRestricted) return dom;
  if (s.dowRestricted) return dow;
  return true;
}

/** The first minute strictly after `after` that the schedule matches (UTC). */
export function nextCronRun(s: CronSchedule, after: Date): Date {
  const t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  // Five years of days is far more than any valid schedule needs (29 February
  // on a Monday comes round within 28 years, but that is not a demo schedule).
  const limit = after.getTime() + 5 * 366 * 86_400_000;
  while (t.getTime() <= limit) {
    if (!s.months.has(t.getUTCMonth() + 1) || !dayMatches(s, t)) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!s.hours.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!s.minutes.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  throw new Error('the cron expression never matches');
}
