import {z} from 'zod';

/** The same optional excerpt contract for the live adapter and standalone snapshot. */
export const previewSchema=z.object({kind:z.enum(['instruction','report']),text:z.string().max(500)}).strict();
