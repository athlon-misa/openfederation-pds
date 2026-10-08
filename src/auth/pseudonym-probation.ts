/**
 * Server-admin option: new pseudonyms get a daily write cap for their first
 * PSEUDONYM_PROBATION_DAYS days (0 disables it). Counts live in this process's
 * memory only and are never stored, so probation leaves no record behind.
 * They reset on restart, which is acceptable for a soft limit.
 */
import { Response } from 'express';
import type { AuthRequest } from './types.js';
import { query } from '../db/client.js';
import { config } from '../config.js';

const counters = new Map<string, { day: string; count: number }>();

export function resetProbationForTests(): void {
  counters.clear();
}

export async function enforcePseudonymProbation(req: AuthRequest, res: Response): Promise<boolean> {
  const { probationDays, probationDailyWrites } = config.pseudonym;
  if (!req.auth || probationDays <= 0) return true;
  const row = (await query<{ in_probation: boolean }>(
    `SELECT (created_at > NOW() - make_interval(days => $2)) AS in_probation
     FROM users WHERE id = $1 AND auth_type = 'pseudonym'`, [req.auth.userId, probationDays])).rows[0];
  if (!row?.in_probation) return true;

  const day = new Date().toISOString().slice(0, 10);
  const entry = counters.get(req.auth.userId);
  const count = entry && entry.day === day ? entry.count : 0;
  if (count >= probationDailyWrites) {
    res.status(429).json({ error: 'ProbationLimit', message: 'New pseudonyms have a daily write limit for their first days.' });
    return false;
  }
  counters.set(req.auth.userId, { day, count: count + 1 });
  return true;
}
