// PostgreSQL returns UUIDs in lower case and the domain compares ids as strings, so every
// UUID that enters the system is normalised here, before hashing and before any comparison.
import { z } from 'zod';

export const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
