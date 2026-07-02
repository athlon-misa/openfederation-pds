import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

// Rate limiters
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 120,              // 120 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RateLimitExceeded', message: 'Too many requests, please try again later' },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: config.rateLimits.authPer15Min,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RateLimitExceeded', message: 'Too many authentication attempts, please try again later' },
});

export const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: config.rateLimits.registrationPerHour,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RateLimitExceeded', message: 'Too many registration attempts, please try again later' },
});

export const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: config.rateLimits.createPerHour,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RateLimitExceeded', message: 'Too many creation requests, please try again later' },
});

export const discoveryLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 60,               // 60 discovery requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RateLimitExceeded', message: 'Too many discovery requests, please try again later' },
});

// Tier 1 custodial-signing: per-IP cap, but also per-DID checked at handler
// level if we ever need finer granularity. Default 60/min per IP matches
// service-auth and keeps a single dApp from saturating the PDS.
export const walletSignLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimits.walletSignPerMin,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RateLimitExceeded', message: 'Too many signing requests, please try again later' },
});
