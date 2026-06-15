/* ========================================================================
 * /grants/ renderer
 * Reads grants.json and renders: audience tabs, month-grid calendar with
 * deadline pins, filtered deadline lists, and a rolling-deadlines panel.
 * ====================================================================== */

(function () {
  'use strict';

  const AUDIENCES = ['students', 'postdocs', 'faculty'];
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const state = {
    grants: [],
    filter: 'all',
    year: 0,
    month: 0,
    today: null
  };

  // -------- date helpers (timezone-safe: parse YYYY-MM-DD as local) --------
  function parseISO(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  function ymd(d) {
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }
  function startOfToday() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }
  // Monday-first weekday index: Mon=0 ... Sun=6
  function weekdayMon(d) {
    return (d.getDay() + 6) % 7;
  }
  function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }
  function formatLong(d) {
    return d.toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    });
  }

  // -------- data shaping --------
  function isHackathon(grant) { return grant.type === 'hackathon'; }
  function filterMatch(grant) {
    const f = state.filter;
    if (f === 'all') return true;
    if (f === 'hackathons') return isHackathon(grant);
    // Audience tabs exclude hackathons.
    if (isHackathon(grant)) return false;
    return Array.isArray(grant.audience) && grant.audience.includes(f);
  }
  // Returns sorted [{grant, date}] for grants matching the current audience filter,
  // with dates >= today (or anywhere if includePast = true).
  function expandedDeadlines(includePast) {
    const out = [];
    const todayKey = ymd(state.today);
    for (const g of state.grants) {
      if (!filterMatch(g)) continue;
      const ds = Array.isArray(g.deadlines) ? g.deadlines : [];
      for (const s of ds) {
        const d = parseISO(s);
        if (!d) continue;
        if (!includePast && ymd(d) < todayKey) continue;
        out.push({ grant: g, date: d });
      }
    }
    out.sort((a, b) => ymd(a.date) - ymd(b.date));
    return out;
  }
  function rollingGrants() {
    return state.grants
      .filter(g => filterMatch(g))
      .filter(g => !Array.isArray(g.deadlines) || g.deadlines.length === 0)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // -------- calendar render --------
  function renderCalendar() {
    const grid = document.getElementById('cal-grid');
    const title = document.getElementById('cal-title');
    const monthName = document.getElementById('month-name');
    title.textContent = `${MONTH_NAMES[state.month]} ${state.year}`;
    monthName.textContent = `${MONTH_NAMES[state.month]} ${state.year}`;

    // Bucket deadlines by date for the displayed month.
    const pins = new Map(); // dateNum -> [{grant, audience-set}]
    for (const { grant, date } of expandedDeadlines(true)) {
      if (date.getFullYear() !== state.year || date.getMonth() !== state.month) continue;
      const key = date.getDate();
      if (!pins.has(key)) pins.set(key, []);
      pins.get(key).push(grant);
    }

    const cells = [];
    for (const w of WEEKDAYS) {
      cells.push(`<div class="cal-wd" role="columnheader">${w}</div>`);
    }
    const first = new Date(state.year, state.month, 1);
    const leading = weekdayMon(first);
    for (let i = 0; i < leading; i++) {
      cells.push('<div class="cal-cell is-blank" role="gridcell" aria-hidden="true"></div>');
    }
    const ndays = daysInMonth(state.year, state.month);
    const todayKey = ymd(state.today);
    for (let day = 1; day <= ndays; day++) {
      const d = new Date(state.year, state.month, day);
      const isToday = ymd(d) === todayKey;
      const dayGrants = pins.get(day) || [];
      const audSet = new Set();
      for (const g of dayGrants) {
        for (const a of (g.audience || [])) audSet.add(a);
      }
      const dots = AUDIENCES
        .filter(a => audSet.has(a))
        .map(a => `<span class="cal-dot" data-audience="${a}" aria-label="${a}"></span>`)
        .join('');
      const isPast = ymd(d) < todayKey;
      const titleAttr = dayGrants.length
        ? ' title="' + dayGrants.map(g => g.name.replace(/"/g, '&quot;')).join('\n') + '"'
        : '';
      const ids = dayGrants.map(g => g.id).join(',');
      const clickAttrs = dayGrants.length
        ? ` data-grant-ids="${ids}" tabindex="0" role="button" aria-label="${dayGrants.length} deadline${dayGrants.length>1?'s':''} on ${MONTH_NAMES[state.month]} ${day}"`
        : ' role="gridcell"';
      cells.push(
        `<div class="cal-cell${isToday ? ' is-today' : ''}${isPast ? ' is-past' : ''}${dayGrants.length ? ' has-pin' : ''}"${clickAttrs}${titleAttr}>
           <span class="cal-num">${day}</span>
           ${dots ? `<span class="cal-dots">${dots}</span>` : ''}
         </div>`
      );
    }
    grid.innerHTML = cells.join('');
  }

  function jumpToGrant(idsCsv) {
    const ids = (idsCsv || '').split(',').filter(Boolean);
    let target = null;
    for (const id of ids) {
      target =
        document.getElementById(`g-month-${id}`) ||
        document.getElementById(`g-upcoming-${id}`) ||
        document.getElementById(`g-rolling-${id}`);
      if (target) break;
    }
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('is-flashing');
    // Force reflow so the animation restarts even if class was just toggled.
    void target.offsetWidth;
    target.classList.add('is-flashing');
    setTimeout(() => target.classList.remove('is-flashing'), 1800);
  }

  // -------- list render --------
  function grantCard(grant, withDeadline, section) {
    const next = withDeadline ? formatLong(withDeadline) : '';
    const aud = (grant.audience || []).join(', ');
    const metaParts = [
      grant.type === 'hackathon' ? 'Hackathon' : null,
      grant.funder,
      grant.region,
      grant.amount,
      grant.duration,
      aud ? `for ${aud}` : null
    ].filter(Boolean);
    return `
      <article id="g-${section}-${grant.id}" class="grant-card">
        <div class="grant-row">
          <h4 class="grant-name"><a href="${grant.url}" target="_blank" rel="noopener">${grant.name}</a></h4>
          ${next ? `<span class="grant-deadline">${next}</span>` : '<span class="grant-deadline grant-rolling">rolling</span>'}
        </div>
        <p class="grant-meta">${metaParts.join(' &middot; ')}</p>
        ${grant.description ? `<p class="grant-desc">${grant.description}</p>` : ''}
        ${grant.deadlineNote ? `<p class="grant-note-line">${grant.deadlineNote}</p>` : ''}
      </article>
    `;
  }

  function renderMonthList() {
    const host = document.getElementById('month-list');
    const items = expandedDeadlines(true).filter(({ date }) =>
      date.getFullYear() === state.year && date.getMonth() === state.month
    );
    if (!items.length) {
      host.innerHTML = '<p class="grants-empty">No deadlines this month for the selected audience.</p>';
      return;
    }
    host.innerHTML = items.map(({ grant, date }) => grantCard(grant, date, 'month')).join('');
  }

  function renderUpcomingList() {
    const host = document.getElementById('upcoming-list');
    const items = expandedDeadlines(false).slice(0, 30);
    if (!items.length) {
      host.innerHTML = '<p class="grants-empty">No upcoming fixed deadlines for the selected audience.</p>';
      return;
    }
    host.innerHTML = items.map(({ grant, date }) => grantCard(grant, date, 'upcoming')).join('');
  }

  function renderRollingList() {
    const host = document.getElementById('rolling-list');
    const items = rollingGrants();
    if (!items.length) {
      host.innerHTML = '<p class="grants-empty">No rolling-deadline grants for the selected audience.</p>';
      return;
    }
    host.innerHTML = items.map(g => grantCard(g, null, 'rolling')).join('');
  }

  function renderAll() {
    renderCalendar();
    renderMonthList();
    renderUpcomingList();
    renderRollingList();
  }

  // -------- wiring --------
  function wireTabs() {
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(t => {
      t.addEventListener('click', () => {
        const f = t.getAttribute('data-filter');
        if (f === state.filter) return;
        state.filter = f;
        tabs.forEach(o => {
          const on = o === t;
          o.classList.toggle('is-active', on);
          o.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        renderAll();
      });
    });
  }
  function wireNav() {
    document.getElementById('cal-prev').addEventListener('click', () => {
      state.month -= 1;
      if (state.month < 0) { state.month = 11; state.year -= 1; }
      renderAll();
    });
    document.getElementById('cal-next').addEventListener('click', () => {
      state.month += 1;
      if (state.month > 11) { state.month = 0; state.year += 1; }
      renderAll();
    });
  }
  function wireCalendarClicks() {
    const grid = document.getElementById('cal-grid');
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.cal-cell.has-pin');
      if (!cell) return;
      jumpToGrant(cell.dataset.grantIds);
    });
    grid.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const cell = e.target.closest('.cal-cell.has-pin');
      if (!cell) return;
      e.preventDefault();
      jumpToGrant(cell.dataset.grantIds);
    });
  }

  function init(data) {
    state.grants = Array.isArray(data.grants) ? data.grants : [];
    state.today = startOfToday();
    state.year = state.today.getFullYear();
    state.month = state.today.getMonth();

    const updatedEl = document.getElementById('grants-updated');
    if (data.lastUpdated) {
      const d = parseISO(data.lastUpdated);
      updatedEl.textContent = d ? formatLong(d) : data.lastUpdated;
    } else {
      updatedEl.textContent = '-';
    }
    document.getElementById('grants-count').textContent = String(state.grants.length);

    wireTabs();
    wireNav();
    wireCalendarClicks();
    renderAll();
  }

  fetch('./grants.json', { cache: 'no-cache' })
    .then(r => {
      if (!r.ok) throw new Error('Failed to load grants.json');
      return r.json();
    })
    .then(init)
    .catch(err => {
      console.error(err);
      const grid = document.getElementById('cal-grid');
      if (grid) grid.innerHTML = '<p class="grants-empty">Could not load grants data. Please try again later.</p>';
    });
})();
