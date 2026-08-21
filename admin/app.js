/* Blessings Home — Ledger (read-only)
   Reads one Google Sheet via the Sheets API. No secrets live here: access is
   controlled by (a) who the Sheet is shared with and (b) the Testing-mode
   test-user allowlist on the OAuth consent screen. */

const CFG = window.ADMIN_CONFIG;
let TOKEN = null;

/* ---------- tiny helpers ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const money = (n) => '₹' + Math.round(n || 0).toLocaleString('en-IN');
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[₹,\s]/g, ''));
  return isNaN(n) ? 0 : n;
};

const today = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };

function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);            // 2026-08-18
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);         // 18/08/2026 (day first)
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
const fmtDate = (d) => d ? d.toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'}) : '';
const daysAgo = (d) => Math.floor((today() - d) / 86400000);

/* Rows -> objects keyed by a normalised header ("Booking ID" -> booking_id) */
function toObjects(values) {
  if (!values || values.length < 2) return [];
  const keys = values[0].map(h => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return values.slice(1)
    .filter(r => r.some(c => String(c ?? '').trim() !== ''))
    .map(r => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
}

/* ---------- auth ---------- */
function signIn() {
  const tc = google.accounts.oauth2.initTokenClient({
    client_id: CFG.CLIENT_ID,
    scope: CFG.SCOPE,
    callback: (resp) => {
      if (resp.error) return showError('Sign-in failed: ' + resp.error);
      TOKEN = resp.access_token;
      $('gate').hidden = true;
      $('app').hidden = false;
      $('hdr-actions').innerHTML = '<button class="btn ghost" id="refresh">Refresh</button>';
      $('refresh').onclick = load;
      load();
    }
  });
  tc.requestAccessToken();
}

function showError(msg) {
  $('app').hidden = false;
  $('app').innerHTML = `<div class="err">${esc(msg)}</div>`;
}

/* ---------- data ---------- */
async function load() {
  $('app').innerHTML = '<p class="empty">Loading…</p>';
  const ranges = Object.values(CFG.TABS).map(r => 'ranges=' + encodeURIComponent(r)).join('&');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.SHEET_ID}/values:batchGet?${ranges}`;
  let data;
  try {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(res.status === 403
        ? 'Google refused the request (403). The signed-in account may not have access to this Sheet.'
        : `Sheets API ${res.status}: ${t.slice(0, 200)}`);
    }
    data = await res.json();
  } catch (e) {
    return showError(e.message);
  }

  const [bk, py, ex] = data.valueRanges.map(v => toObjects(v.values));
  render(bk, py, ex);
}

/* ---------- render ---------- */
function render(bookings, payments, expenses) {
  // money received per booking (deposit & its refund are not rent)
  const RENT = ['advance', 'balance', 'extra'];
  const paid = {};
  payments.forEach(p => {
    if (!RENT.includes(String(p.type).trim().toLowerCase())) return;
    paid[p.booking_id] = (paid[p.booking_id] || 0) + num(p.amount);
  });

  bookings.forEach(b => {
    b._total = num(b.total_agreed);
    b._paid = paid[b.booking_id] || 0;
    b._due = b._total - b._paid;
    b._in = parseDate(b.planned_in);
    b._out = parseDate(b.planned_out);
    b._status = String(b.status || '').trim();
  });

  const t = today();
  const owed = bookings.filter(b => b._due > 0 && b._total > 0)
                       .sort((a, b) => (a._in || 0) - (b._in || 0));
  const totalOwed = owed.reduce((s, b) => s + b._due, 0);

  const thisMonth = (d) => d && d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear();
  const revMonth = payments.filter(p => thisMonth(parseDate(p.date)) && RENT.includes(String(p.type).toLowerCase()))
                           .reduce((s, p) => s + num(p.amount), 0);
  const expMonth = expenses.filter(e => thisMonth(parseDate(e.date)))
                           .reduce((s, e) => s + num(e.amount), 0);

  const current  = bookings.filter(b => b._in && b._out && b._in <= t && b._out >= t);
  const upcoming = bookings.filter(b => b._in && b._in > t).sort((a, b) => a._in - b._in);

  const srcTag = (s) => {
    const k = String(s).toLowerCase();
    const cls = k === 'airbnb' ? 't-airbnb' : k === 'direct' ? 't-direct' : 't-agent';
    return s ? `<span class="tag ${cls}">${esc(s)}</span>` : '';
  };

  const waLink = (b) => {
    const phone = String(b.phone || '').replace(/\D/g, '');
    if (!phone) return '';
    const n = phone.length === 10 ? '91' + phone : phone;
    const msg = `Hello ${b.guest_name}, a gentle reminder about the pending balance of ${money(b._due)} for your stay at Blessings Home (${fmtDate(b._in)}). Thank you! 🙏`;
    return `<a class="wa" href="https://wa.me/${n}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">WhatsApp →</a>`;
  };

  const bookingRow = (b, showDue) => {
    const late = showDue && b._in && b._in < t;
    return `<div class="row ${showDue && b._due > 0 ? 'owed' : ''}">
      <div>
        <div class="who">${esc(b.guest_name)}${srcTag(b.source)}${b._status.toLowerCase() === 'bad debt' ? '<span class="tag t-bad">bad debt</span>' : ''}</div>
        <div class="meta">${esc(b.booking_id)} · ${esc(b.unit)} · ${fmtDate(b._in)}${b._out ? ' → ' + fmtDate(b._out) : ''}
          ${late ? ` · <strong style="color:var(--danger)">${daysAgo(b._in)} days ago</strong>` : ''}
          ${b.city ? ' · ' + esc(b.city) : ''}</div>
        ${showDue ? `<div class="meta">${waLink(b)}</div>` : ''}
      </div>
      <div class="amt">${showDue ? money(b._due) : (b._total ? money(b._total) : '<span style="color:var(--mut);font-weight:400">—</span>')}</div>
    </div>`;
  };

  const list = (arr, fn, emptyMsg) =>
    `<div class="card">${arr.length ? arr.map(fn).join('') : `<div class="empty">${emptyMsg}</div>`}</div>`;

  const missing = bookings.filter(b => !b._total).length;

  $('app').innerHTML = `
    <div class="tiles">
      <div class="tile ${totalOwed > 0 ? 'alert' : 'good'}"><div class="k">Outstanding</div><div class="v">${money(totalOwed)}</div></div>
      <div class="tile"><div class="k">Received this month</div><div class="v">${money(revMonth)}</div></div>
      <div class="tile"><div class="k">Spent this month</div><div class="v">${money(expMonth)}</div></div>
      <div class="tile ${revMonth - expMonth >= 0 ? 'good' : 'alert'}"><div class="k">Net this month</div><div class="v">${money(revMonth - expMonth)}</div></div>
    </div>

    <section>
      <h2>Money due <span class="count">${owed.length}</span></h2>
      ${list(owed, b => bookingRow(b, true), 'Nothing outstanding. 🎉')}
    </section>

    <section>
      <h2>Staying now <span class="count">${current.length}</span></h2>
      ${list(current, b => bookingRow(b, false), 'Nobody in the house today.')}
    </section>

    <section>
      <h2>Upcoming <span class="count">${upcoming.length}</span></h2>
      ${list(upcoming.slice(0, 8), b => bookingRow(b, false), 'No bookings on the calendar yet.')}
    </section>

    <section>
      <h2>All bookings <span class="count">${bookings.length}</span></h2>
      <div class="card tblwrap">
        <table>
          <thead><tr>
            <th>ID</th><th>Guest</th><th>Unit</th><th>In</th><th>Out</th>
            <th>Source</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Due</th><th>Status</th>
          </tr></thead>
          <tbody>
            ${bookings.map(b => `<tr>
              <td>${esc(b.booking_id)}</td>
              <td>${esc(b.guest_name)}</td>
              <td>${esc(b.unit)}</td>
              <td>${fmtDate(b._in)}</td>
              <td>${fmtDate(b._out)}</td>
              <td>${esc(b.source)}</td>
              <td class="num">${b._total ? money(b._total) : '—'}</td>
              <td class="num">${b._paid ? money(b._paid) : '—'}</td>
              <td class="num" ${b._due > 0 ? 'style="color:var(--danger);font-weight:700"' : ''}>${b._total ? money(b._due) : '—'}</td>
              <td>${esc(b._status)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${missing ? `<div class="note">⚠️ ${missing} booking${missing > 1 ? 's have' : ' has'} no agreed total yet — these are excluded from the outstanding figure. Fill them in on the Bookings tab.</div>` : ''}
    </section>

    <section>
      <h2>Recent expenses <span class="count">${expenses.length}</span></h2>
      ${list(expenses.slice(-8).reverse(), e => `<div class="row">
        <div><div class="who">${esc(e.item || e.category || 'Expense')}</div>
        <div class="meta">${fmtDate(parseDate(e.date))}${e.category ? ' · ' + esc(e.category) : ''}${e.person_responsible ? ' · ' + esc(e.person_responsible) : ''}</div></div>
        <div class="amt">${money(num(e.amount))}</div></div>`, 'No expenses recorded yet.')}
    </section>

    <p class="note">Read-only. To add or change anything, open the
      <a href="https://docs.google.com/spreadsheets/d/${CFG.SHEET_ID}/edit" target="_blank" rel="noopener">ledger sheet</a>.</p>
  `;
}

/* ---------- boot ---------- */
$('signin').onclick = () => {
  if (!window.google?.accounts?.oauth2) {
    $('gate-note').textContent = 'Google sign-in is still loading — try again in a moment.';
    return;
  }
  signIn();
};
