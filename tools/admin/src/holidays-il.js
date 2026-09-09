// ---------------------------------------------------------------------------
// Israeli Jewish holidays, 2026–2027, as marked-day entries.
//
// Generated from Hebcal (v6.9.2, fetched 2026-09-09) and checked in as data
// rather than fetched at run time: it is reviewable in a diff, deterministic,
// works offline, and refreshing it for 2028 is one curl and a paste.
//
//   https://www.hebcal.com/hebcal?v=1&cfg=json&year=<YYYY>&month=x
//     &maj=on&min=off&mod=on&nx=off&ss=off&mf=off&c=off&geo=none&i=on&lg=s
//
// i=on IS LOAD-BEARING. It selects the ISRAEL schedule. The Diaspora keeps a
// second day of each festival, so without it Pesach, Shavuot, Rosh Hashana and
// Sukkot all come out a day too long and Simchat Torah splits off from Shmini
// Atzeret. This is the most likely way for the table to be quietly wrong.
//
// CHOL HAMOED IS EXCLUDED — the intermediate days of Pesach and Sukkot are
// working days here. That is why each of those festivals is two entries (the
// chag at either end) rather than one span, and why Hoshana Raba is absent even
// though it abuts Shmini Atzeret. Erev days are kept: they are legally
// shortened workdays in Israel, which is a different thing from an
// intermediate day.
//
// Ids are deterministic, never generated, which is what makes seeding an upsert
// and re-running it a no-op. Do not replace them with random ids.
// ---------------------------------------------------------------------------

// { id, date, end, label } — `color` is applied by the seed command, so every
// entry gets the same one and changing it is a flag rather than an edit here.
export const HOLIDAYS_IL = [
  // --- 2026 ---
  { id: "il-2026-purim",                     date: "2026-03-03", end: "2026-03-03", label: "Purim" },
  { id: "il-2026-pesach",                    date: "2026-04-01", end: "2026-04-02", label: "Pesach" },
  { id: "il-2026-pesach-vii",                date: "2026-04-08", end: "2026-04-08", label: "Pesach VII" },
  { id: "il-2026-yom-hazikaron-haatzmaut",   date: "2026-04-21", end: "2026-04-22", label: "Yom HaZikaron / HaAtzma’ut" },
  { id: "il-2026-shavuot",                   date: "2026-05-21", end: "2026-05-22", label: "Shavuot" },
  { id: "il-2026-tisha-bav",                 date: "2026-07-23", end: "2026-07-23", label: "Tish’a B’Av" },
  { id: "il-2026-rosh-hashana",              date: "2026-09-11", end: "2026-09-13", label: "Rosh Hashana" },
  { id: "il-2026-yom-kippur",                date: "2026-09-20", end: "2026-09-21", label: "Yom Kippur" },
  { id: "il-2026-sukkot",                    date: "2026-09-25", end: "2026-09-26", label: "Sukkot" },
  { id: "il-2026-shmini-atzeret",            date: "2026-10-03", end: "2026-10-03", label: "Shmini Atzeret" },

  // --- 2027 ---
  { id: "il-2027-purim",                     date: "2027-03-23", end: "2027-03-23", label: "Purim" },
  { id: "il-2027-pesach",                    date: "2027-04-21", end: "2027-04-22", label: "Pesach" },
  { id: "il-2027-pesach-vii",                date: "2027-04-28", end: "2027-04-28", label: "Pesach VII" },
  { id: "il-2027-yom-hazikaron-haatzmaut",   date: "2027-05-11", end: "2027-05-12", label: "Yom HaZikaron / HaAtzma’ut" },
  { id: "il-2027-shavuot",                   date: "2027-06-10", end: "2027-06-11", label: "Shavuot" },
  { id: "il-2027-tisha-bav",                 date: "2027-08-12", end: "2027-08-12", label: "Tish’a B’Av" },
  { id: "il-2027-rosh-hashana",              date: "2027-10-01", end: "2027-10-03", label: "Rosh Hashana" },
  { id: "il-2027-yom-kippur",                date: "2027-10-10", end: "2027-10-11", label: "Yom Kippur" },
  { id: "il-2027-sukkot",                    date: "2027-10-15", end: "2027-10-16", label: "Sukkot" },
  { id: "il-2027-shmini-atzeret",            date: "2027-10-23", end: "2027-10-23", label: "Shmini Atzeret" }
];

// Violet, from the palette in src/config.js. Deliberately not a warm tone: the
// chart tints these at 22%, and --weekend is already a warm cream in light mode,
// so an amber holiday would be hard to tell from a Friday at a glance.
export const HOLIDAY_COLOR = "#a78bda";

// Marks this table's rows in a workspace's dayMarks, so --replace can find its
// own previous output without touching anything added by hand in the app.
export const SEED_ID_PREFIX = "il-";
