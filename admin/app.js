/* Blessings Home — Ledger (read-only)
   Reads one Google Sheet via the Sheets API and renders it as a small tabbed
   web app. No secrets live here: access is controlled by (a) who the Sheet is
   shared with and (b) the Testing-mode test-user allowlist on the consent
   screen. Scope is spreadsheets.readonly, so nothing here can alter the data. */

const CFG = window.ADMIN_CONFIG;
let TOKEN = null;
let DATA = null;          // {bookings, payments, expenses, meters, inventory}
let VIEW = 'summary';

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const money = (n) => '₹' + Math.round(n || 0).toLocaleString('en-IN');
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[₹,\s]/g,'')); return isNaN(n) ? 0 : n; };
const today = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };

function parseDate(v){
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);        // day-first
  if (m) return new Date(+m[3], +m[2]-1, +m[1]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
const fmtDate = (d) => d ? d.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}) : '';
const shortDate = (d) => d ? d.toLocaleDateString('en-IN',{day:'numeric',month:'short'}) : '—';
const daysAgo = (d) => Math.floor((today() - d)/86400000);
const monthName = (d) => d.toLocaleDateString('en-IN',{month:'long',year:'numeric'});

function toObjects(values){
  if (!values || values.length < 2) return [];
  const keys = values[0].map(h => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,''));
  return values.slice(1)
    .filter(r => r.some(c => String(c ?? '').trim() !== ''))
    .map(r => Object.fromEntries(keys.map((k,i) => [k, r[i] ?? ''])));
}

const RENT = ['advance','balance','extra'];
const isRent = (t) => RENT.includes(String(t).trim().toLowerCase());

/* ---------- auth ---------- */
function signIn(){
  google.accounts.oauth2.initTokenClient({
    client_id: CFG.CLIENT_ID,
    scope: CFG.SCOPE,
    callback: (r) => {
      if (r.error) { $('gate-note').textContent = 'Sign-in failed: ' + r.error; return; }
      TOKEN = r.access_token;
      $('gate').hidden = true;
      $('shell').hidden = false;
      buildNav();
      load();
    }
  }).requestAccessToken();
}

/* Access tokens expire after about an hour. Rather than showing a bare 401,
   drop back to the gate and let the user sign in again in one click. */
function expired(){
  TOKEN = null;
  $('shell').hidden = true;
  $('gate').hidden = false;
  $('gate-note').textContent = 'Your session timed out — sign in again to reload the ledger.';
}

/* ---------- data ---------- */
async function load(){
  $('view').innerHTML = '<p class="empty">Loading…</p>';
  const ranges = Object.values(CFG.TABS).map(r => 'ranges=' + encodeURIComponent(r)).join('&');
  try {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${CFG.SHEET_ID}/values:batchGet?${ranges}`,
                            { headers:{ Authorization:'Bearer ' + TOKEN } });
    if (res.status === 401) return expired();   // token lasts ~1 hour
    if (!res.ok) throw new Error(res.status === 403
      ? 'Google refused the request (403). The signed-in account may not have access to this Sheet.'
      : `Sheets API ${res.status}`);
    const j = await res.json();
    const keys = Object.keys(CFG.TABS);
    DATA = {};
    keys.forEach((k,i) => DATA[k] = toObjects(j.valueRanges[i]?.values));
    enrich();
    buildNav();
    render();
  } catch(e){
    $('view').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

function enrich(){
  const paid = {};
  DATA.payments.forEach(p => {
    if (!isRent(p.type)) return;
    paid[p.booking_id] = (paid[p.booking_id] || 0) + num(p.amount);
  });
  DATA.bookings.forEach(b => {
    b._total = num(b.total_agreed);
    b._paid  = paid[b.booking_id] || 0;
    b._due   = b._total - b._paid;
    b._in    = parseDate(b.planned_in);
    b._out   = parseDate(b.planned_out);
    b._status= String(b.status || '').trim();
  });
  DATA.bookingById = Object.fromEntries(DATA.bookings.map(b => [b.booking_id, b]));
}

/* ---------- shared bits ---------- */
const srcTag = (s) => {
  const k = String(s).toLowerCase();
  const cls = k === 'airbnb' ? 't-airbnb' : k === 'direct' ? 't-direct' : 't-agent';
  return s ? `<span class="tag ${cls}">${esc(s)}</span>` : '';
};
const waLink = (b) => {
  const phone = String(b.phone || '').replace(/\D/g,'');
  if (!phone) return '';
  const n = phone.length === 10 ? '91' + phone : phone;
  const msg = `Hello ${b.guest_name}, a gentle reminder about the pending balance of ${money(b._due)} for your booking at Blessings Home (${fmtDate(b._in)}). Thank you! 🙏`;
  return `<a class="wa" href="https://wa.me/${n}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">WhatsApp reminder →</a>`;
};
const list = (arr, fn, msg) => `<div class="card">${arr.length ? arr.map(fn).join('') : `<div class="empty">${msg}</div>`}</div>`;

function bookingRow(b, showDue){
  const late = showDue && b._in && b._in < today();
  return `<div class="row ${showDue && b._due > 0 ? 'owed' : ''}">
    <div>
      <div class="who">${esc(b.guest_name)}${srcTag(b.source)}${b._status.toLowerCase()==='bad debt'?'<span class="tag t-bad">bad debt</span>':''}</div>
      <div class="meta">${esc(b.booking_id)} · ${esc(b.unit)} · ${fmtDate(b._in)}${b._out?' → '+fmtDate(b._out):''}
        ${late?` · <strong style="color:var(--danger)">${daysAgo(b._in)} days ago</strong>`:''}${b.city?' · '+esc(b.city):''}</div>
      ${showDue ? `<div class="meta">${waLink(b)}</div>` : ''}
    </div>
    <div class="amt">${showDue ? money(b._due) : (b._total ? money(b._total) : '—')}</div>
  </div>`;
}

/* ---------- views ---------- */
function viewSummary(){
  const t = today();
  const owed = DATA.bookings.filter(b => b._due > 0 && b._total > 0).sort((a,b)=>(a._in||0)-(b._in||0));
  const totalOwed = owed.reduce((s,b)=>s+b._due,0);
  const inMonth = (d) => d && d.getMonth()===t.getMonth() && d.getFullYear()===t.getFullYear();
  const rev = DATA.payments.filter(p=>inMonth(parseDate(p.date)) && isRent(p.type)).reduce((s,p)=>s+num(p.amount),0);
  const exp = DATA.expenses.filter(e=>inMonth(parseDate(e.date))).reduce((s,e)=>s+num(e.amount),0);
  const current  = DATA.bookings.filter(b=>b._in&&b._out&&b._in<=t&&b._out>=t);
  const upcoming = DATA.bookings.filter(b=>b._in&&b._in>t).sort((a,b)=>a._in-b._in);
  const missing  = DATA.bookings.filter(b=>!b._total).length;

  return `
    <div class="head"><h1>Summary</h1><div class="sub">${monthName(t)}</div></div>
    <div class="tiles">
      <div class="tile ${totalOwed>0?'alert':'good'}"><div class="k">Outstanding</div><div class="v">${money(totalOwed)}</div><div class="s">${owed.length} booking${owed.length===1?'':'s'}</div></div>
      <div class="tile"><div class="k">Received this month</div><div class="v">${money(rev)}</div></div>
      <div class="tile"><div class="k">Spent this month</div><div class="v">${money(exp)}</div></div>
      <div class="tile ${rev-exp>=0?'good':'alert'}"><div class="k">Net this month</div><div class="v">${money(rev-exp)}</div></div>
    </div>
    <section><h2>Money due <span class="count">${owed.length}</span></h2>
      ${list(owed, b=>bookingRow(b,true), 'Nothing outstanding. 🎉')}</section>
    <section><h2>Staying now <span class="count">${current.length}</span></h2>
      ${list(current, b=>bookingRow(b,false), 'Nobody in the house today.')}</section>
    <section><h2>Upcoming <span class="count">${upcoming.length}</span></h2>
      ${list(upcoming.slice(0,6), b=>bookingRow(b,false), 'No bookings on the calendar yet.')}</section>
    ${missing?`<p class="note">⚠️ ${missing} booking${missing>1?'s have':' has'} no agreed total yet — excluded from the outstanding figure.</p>`:''}`;
}

function viewBookings(){
  const rows = DATA.bookings.slice().sort((a,b)=>(b._in||0)-(a._in||0));
  return `
    <div class="head"><h1>Bookings</h1><div class="sub">${rows.length} in total</div></div>
    <div class="filters">
      <input id="q" placeholder="Search guest, ID, city, unit…">
      <select id="fsrc"><option value="">All sources</option><option>Direct</option><option>Airbnb</option><option>Agent</option></select>
      <select id="fst"><option value="">All statuses</option><option>Confirmed</option><option>Completed</option><option>Staying</option><option>Bad debt</option><option>Cancelled</option><option>Enquiry</option></select>
    </div>
    <div class="card tblwrap">
      <table><thead><tr>
        <th>ID</th><th>Guest</th><th>Unit</th><th>In</th><th>Out</th><th>Source</th>
        <th class="num">Total</th><th class="num">Paid</th><th class="num">Due</th><th>Status</th>
      </tr></thead><tbody id="btbody">${rows.map(bookingTr).join('')}</tbody></table>
    </div>`;
}
const bookingTr = (b) => `<tr data-s="${esc((b.guest_name+' '+b.booking_id+' '+b.city+' '+b.unit).toLowerCase())}"
    data-src="${esc(b.source)}" data-st="${esc(b._status)}">
  <td>${esc(b.booking_id)}</td><td>${esc(b.guest_name)}</td><td>${esc(b.unit)}</td>
  <td>${shortDate(b._in)}</td><td>${shortDate(b._out)}</td><td>${esc(b.source)}</td>
  <td class="num">${b._total?money(b._total):'—'}</td>
  <td class="num">${b._paid?money(b._paid):'—'}</td>
  <td class="num" ${b._due>0?'style="color:var(--danger);font-weight:700"':''}>${b._total?money(b._due):'—'}</td>
  <td>${esc(b._status)}</td></tr>`;

function viewMoney(){
  const t = today();
  const byMonth = {};
  const add = (d, key, amt) => {
    if (!d) return;
    const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    (byMonth[k] = byMonth[k] || {in:0,out:0,label:monthName(d)})[key] += amt;
  };
  DATA.payments.forEach(p => { if (isRent(p.type)) add(parseDate(p.date),'in',num(p.amount)); });
  DATA.expenses.forEach(e => add(parseDate(e.date),'out',num(e.amount)));
  const months = Object.keys(byMonth).sort().reverse();
  const totIn  = DATA.payments.filter(p=>isRent(p.type)).reduce((s,p)=>s+num(p.amount),0);
  const totOut = DATA.expenses.reduce((s,e)=>s+num(e.amount),0);

  const pay = DATA.payments.slice().sort((a,b)=>(parseDate(b.date)||0)-(parseDate(a.date)||0));
  const exp = DATA.expenses.slice().sort((a,b)=>(parseDate(b.date)||0)-(parseDate(a.date)||0));

  return `
    <div class="head"><h1>Income &amp; expenses</h1><div class="sub">all time</div></div>
    <div class="tiles">
      <div class="tile good"><div class="k">Total received</div><div class="v">${money(totIn)}</div><div class="s">${DATA.payments.length} payments</div></div>
      <div class="tile"><div class="k">Total spent</div><div class="v">${money(totOut)}</div><div class="s">${DATA.expenses.length} expenses</div></div>
      <div class="tile ${totIn-totOut>=0?'good':'alert'}"><div class="k">Net</div><div class="v">${money(totIn-totOut)}</div></div>
    </div>

    <section><h2>By month</h2>
      <div class="card tblwrap"><table><thead><tr>
        <th>Month</th><th class="num">In</th><th class="num">Out</th><th class="num">Net</th>
      </tr></thead><tbody>
        ${months.map(k=>{const m=byMonth[k];const n=m.in-m.out;return `<tr><td>${esc(m.label)}</td>
          <td class="num">${m.in?money(m.in):'—'}</td><td class="num">${m.out?money(m.out):'—'}</td>
          <td class="num" style="font-weight:700;color:${n>=0?'var(--palm)':'var(--danger)'}">${money(n)}</td></tr>`}).join('')}
      </tbody></table></div>
    </section>

    <section><h2>Payments in <span class="count">${pay.length}</span></h2>
      ${list(pay, p => {
        const b = DATA.bookingById?.[p.booking_id];
        return `<div class="row"><div>
          <div class="who">${b?esc(b.guest_name):esc(p.booking_id||'—')}
            <span class="tag ${isRent(p.type)?'t-direct':'t-agent'}">${esc(p.type||'—')}</span></div>
          <div class="meta">${shortDate(parseDate(p.date))}${p.mode_of_pay?' · '+esc(p.mode_of_pay):''}${p.booking_id?' · '+esc(p.booking_id):''}</div>
        </div><div class="amt">${money(num(p.amount))}</div></div>`;
      }, 'No payments recorded yet.')}</section>

    <section><h2>Expenses out <span class="count">${exp.length}</span></h2>
      ${list(exp, e => `<div class="row"><div>
        <div class="who">${esc(e.item || e.category || 'Expense')}
          ${e.category?`<span class="tag ${String(e.category).toLowerCase()==='inventory'?'t-inv':'t-agent'}">${esc(e.category)}</span>`:''}</div>
        <div class="meta">${shortDate(parseDate(e.date))}${e.person_responsible?' · '+esc(e.person_responsible):''}${e.booking_id?' · charged to '+esc(e.booking_id):''}${String(e.bill_present).toLowerCase()==='yes'?' · 🧾 bill':''}</div>
      </div><div class="amt">${money(num(e.amount))}</div></div>`, 'No expenses recorded yet.')}</section>`;
}

function viewInventory(){
  const inv = DATA.inventory || [];
  const cats = [...new Set(inv.map(i=>i.category).filter(Boolean))];
  const value = inv.reduce((s,i)=>s+num(i.cost_rs),0);
  return `
    <div class="head"><h1>Inventory</h1><div class="sub">${inv.length} line${inv.length===1?'':'s'}</div></div>
    <div class="tiles">
      <div class="tile"><div class="k">Recorded lines</div><div class="v">${inv.length}</div></div>
      <div class="tile"><div class="k">Categories</div><div class="v">${cats.length}</div></div>
      <div class="tile"><div class="k">Cost recorded</div><div class="v">${money(value)}</div><div class="s">where known</div></div>
    </div>
    <div class="filters">
      <input id="qi" placeholder="Search item, location, details…">
      <select id="fcat"><option value="">All categories</option>${cats.map(c=>`<option>${esc(c)}</option>`).join('')}</select>
    </div>
    <div class="card tblwrap">
      <table><thead><tr>
        <th>Item</th><th>Category</th><th class="num">Qty</th><th>Location</th><th>Details</th><th class="num">Cost</th>
      </tr></thead><tbody id="itbody">
        ${inv.map(i=>`<tr data-s="${esc((i.item+' '+i.location+' '+i.details).toLowerCase())}" data-cat="${esc(i.category)}">
          <td><strong>${esc(i.item)}</strong>${i.notes?`<div class="meta" style="font-size:.72rem">${esc(i.notes)}</div>`:''}</td>
          <td>${esc(i.category)}</td><td class="num">${esc(i.qty)}</td>
          <td>${esc(i.location)}</td><td>${esc(i.details)}</td>
          <td class="num">${num(i.cost_rs)?money(num(i.cost_rs)):'—'}</td></tr>`).join('')}
      </tbody></table>
    </div>
    ${inv.length?'':'<p class="note">The Inventory tab in the sheet is still being filled in.</p>'}`;
}

/* ---------- nav + wiring ---------- */
const VIEWS = [
  {id:'summary',   ic:'📊', label:'Summary',  fn:viewSummary},
  {id:'bookings',  ic:'📅', label:'Bookings', fn:viewBookings},
  {id:'money',     ic:'💰', label:'Money',    fn:viewMoney},
  {id:'inventory', ic:'📦', label:'Inventory',fn:viewInventory}
];

function buildNav(){
  const due = DATA ? DATA.bookings.filter(b=>b._due>0&&b._total>0).length : 0;
  $('nav').innerHTML = VIEWS.map(v => `<button data-v="${v.id}" class="${v.id===VIEW?'on':''}">
      <span class="ic">${v.ic}</span><span>${v.label}</span>
      ${v.id==='summary'&&due?`<span class="pill">${due}</span>`:''}</button>`).join('');
  $('nav').querySelectorAll('button').forEach(b => b.onclick = () => { VIEW = b.dataset.v; buildNav(); render(); window.scrollTo(0,0); });
}

function render(){
  if (!DATA) return;
  $('view').innerHTML = (VIEWS.find(v=>v.id===VIEW) || VIEWS[0]).fn();
  wireFilters();
}

function wireFilters(){
  const filter = (inputId, bodyId, selIds) => {
    const inp = $(inputId); if (!inp) return;
    const apply = () => {
      const q = inp.value.trim().toLowerCase();
      const sels = selIds.map(s => [s.attr, ($(s.id)?.value || '').toLowerCase()]);
      $(bodyId).querySelectorAll('tr').forEach(tr => {
        const okQ = !q || tr.dataset.s.includes(q);
        const okS = sels.every(([attr,val]) => !val || (tr.dataset[attr]||'').toLowerCase() === val);
        tr.style.display = (okQ && okS) ? '' : 'none';
      });
    };
    inp.oninput = apply;
    selIds.forEach(s => { const el = $(s.id); if (el) el.onchange = apply; });
  };
  filter('q','btbody',[{id:'fsrc',attr:'src'},{id:'fst',attr:'st'}]);
  filter('qi','itbody',[{id:'fcat',attr:'cat'}]);
}

/* ---------- boot ---------- */
$('signin').onclick = () => {
  if (!window.google?.accounts?.oauth2) { $('gate-note').textContent = 'Google sign-in is still loading — try again in a moment.'; return; }
  signIn();
};
document.addEventListener('click', e => { if (e.target.id === 'refresh') load(); });
