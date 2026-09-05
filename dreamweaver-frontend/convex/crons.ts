import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily(
  "purge-expired-trashed-storyboards",
  {
    hourUTC: 3,
    minuteUTC: 30,
  },
  internal.storyboards.purgeExpiredTrashedStoryboardsInternal,
  { limit: 200 },
);

// M7 — translation cache eviction. Runs shortly after the trashed-
// storyboard purge so any `subtitleTranslations` rows whose owning
// storyboard was just deleted also get cleaned up on the same tick.
// Separate offset avoids both jobs contending for the same DB
// iteration slot.
crons.daily(
  "purge-stale-subtitle-translations",
  {
    hourUTC: 3,
    minuteUTC: 45,
  },
  internal.subtitleTranslations.purgeStaleTranslationsInternal,
  { limit: 500 },
);

// M9 — narrative variant catalog eviction. Variant branches that were
// never picked and haven't been touched in 14 days get archived so
// the variant picker doesn't drown in abandoned hook/remix attempts.
// Run 15 min after the subtitle purge for the same
// slot-contention-avoidance reason.
crons.daily(
  "purge-stale-narrative-variants",
  {
    hourUTC: 4,
    minuteUTC: 0,
  },
  internal.narrativeState.purgeStaleVariantsInternal,
  { limit: 500 },
);

export default crons;

