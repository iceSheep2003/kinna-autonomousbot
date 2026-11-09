import { z } from 'zod';
export const text = z.string().min(1).max(8000);
export const id = z.string().min(1).max(120);
export const refs = z.array(z.number().int().positive()).max(40);
