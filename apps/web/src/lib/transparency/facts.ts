// Facts for the public transparency report (/transparency). The OWNER keeps these current: see
// docs/v2/03-transparency.md "Owner checklist". Change the numbers and re-date `asOf` whenever a request
// arrives, and at least every three months even when nothing changed (the page says so).

export const TRANSPARENCY_FACTS = {
  /** Date the statement and the counts below were last checked by the owner (YYYY-MM-DD). */
  asOf: '2026-10-21',
  /** Start of the reporting period: Kithwall 2's first deployment. */
  since: '2026-10-17',
  requests: {
    /** Requests from police, courts or governments for information about users. */
    userData: 0,
    /** …of which we produced some data. */
    produced: 0,
    /** Requests to preserve an account's data. */
    preservation: 0,
    /** Requests to remove content or accounts (from governments or courts). */
    removal: 0,
    /** Emergency disclosure requests. */
    emergency: 0,
  },
  /** How often the owner re-dates the statement. */
  reviewMonths: 3,
} as const;
