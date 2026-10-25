import { defineConfig } from 'drizzle-kit'

/**
 * Authoring-time only: `npm run db:generate` diffs `schema.ts` against the
 * migration history and writes the next SQL file. The server never reads this
 * — it applies the committed SQL in `drizzle/` (see src/db/index.ts).
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
