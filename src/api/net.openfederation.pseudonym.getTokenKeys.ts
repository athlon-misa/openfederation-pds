import { Request, Response } from 'express';
import { publishedEpochs } from '../identity/pseudonym/tokens.js';

/** Public and unauthenticated: clients fetch this anonymously to pin the epoch keys. */
export default async function getTokenKeys(_req: Request, res: Response): Promise<void> {
  try {
    res.status(200).json({ keys: await publishedEpochs() });
  } catch (error) {
    console.error('Error in pseudonym.getTokenKeys:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to load token keys' });
  }
}
