/* Public by design.
   Neither value grants access to anything on its own — the Sheet is shared with
   nobody, and the OAuth consent screen is in Testing mode with a single
   authorised account. A stranger with both of these still gets nothing. */
window.ADMIN_CONFIG = {
  CLIENT_ID: '856631534766-8f73v12qi62fv9t12n6s81erf1irru5d.apps.googleusercontent.com',
  SHEET_ID:  '1SDL_3CsOomn4MZ5q7pG620SYBWdfm2wvVJfrQU8mYKU',
  SCOPE:     'https://www.googleapis.com/auth/spreadsheets.readonly',
  TABS: {
    bookings: 'Bookings!A:Q',
    payments: 'Payments!A:H',
    expenses: 'Expenses!A:I',
    meters:   "'Meter Readings'!A:E"
  }
};
