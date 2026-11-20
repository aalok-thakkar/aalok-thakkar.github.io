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

  // Discipline taxonomy. Entries carry `disciplines`: specific slugs, or the
  // wildcards 'all' (every discipline), 'stem' or 'hss' (every slug in those groups).
  const DISC_GROUPS = [
    { id: 'natural', label: 'Natural sciences', kind: 'stem', items: [
      ['physics', 'Physics and astronomy'],
      ['chemistry', 'Chemistry and materials'],
      ['life-sciences', 'Life sciences'],
      ['earth-environment', 'Earth, environment and climate']] },
    { id: 'computing', label: 'Mathematics and computing', kind: 'stem', items: [
      ['mathematics', 'Mathematics'],
      ['computer-science', 'Computer science']] },
    { id: 'applied', label: 'Engineering and medicine', kind: 'stem', items: [
      ['engineering', 'Engineering and technology'],
      ['medicine-health', 'Medicine and public health']] },
    { id: 'social', label: 'Social sciences', kind: 'hss', items: [
      ['economics', 'Economics'],
      ['politics-law-policy', 'Politics, law and policy'],
      ['sociology-anthropology', 'Sociology and anthropology'],
      ['psychology-cognitive', 'Psychology and cognitive science'],
      ['education', 'Education']] },
    { id: 'humanities', label: 'Humanities and arts', kind: 'hss', items: [
      ['history-archaeology', 'History and archaeology'],
      ['philosophy-religion', 'Philosophy and religion'],
      ['languages-literature', 'Languages and literature'],
      ['arts-design', 'Arts and design'],
      ['area-studies', 'Area studies']] }
  ];
  const DISC_LABEL = {};
  const WILDCARD = { all: [], stem: [], hss: [] };
  for (const grp of DISC_GROUPS) {
    for (const [slug, label] of grp.items) {
      DISC_LABEL[slug] = label;
      WILDCARD.all.push(slug);
      WILDCARD[grp.kind].push(slug);
    }
  }
  const WILDCARD_LABEL = {
    all: 'All disciplines', stem: 'All sciences', hss: 'All humanities and social sciences'
  };

  const PAGE = 20;

  const state = {
    grants: [],
    filter: 'all',
    disc: 'all',
    query: '',
    shown: { upcoming: PAGE, rolling: PAGE },
    year: 0,
    month: 0,
    today: null
  };

  // Grant text comes from grants.json; escape it before inserting as HTML.
  function escapeHTML(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function safeURL(u) {
    return /^https?:\/\//i.test(u || '') ? escapeHTML(u) : '#';
  }

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
  function isRolling(grant) {
    return !Array.isArray(grant.deadlines) || grant.deadlines.length === 0;
  }
  function grantDisciplines(grant) {
    if (Array.isArray(grant.disciplines) && grant.disciplines.length) return grant.disciplines;
    return ['all'];
  }
  // Set of specific slugs an entry covers, with wildcards expanded.
  function coveredSlugs(grant) {
    if (!grant._covered) {
      const out = new Set();
      for (const t of grantDisciplines(grant)) {
        if (WILDCARD[t]) WILDCARD[t].forEach(x => out.add(x));
        else out.add(t);
      }
      grant._covered = out;
    }
    return grant._covered;
  }
  function discMatchValue(grant, value) {
    if (value === 'all') return true;
    const covered = coveredSlugs(grant);
    if (value.startsWith('group:')) {
      const grp = DISC_GROUPS.find(x => x.id === value.slice(6));
      return grp ? grp.items.some(([slug]) => covered.has(slug)) : false;
    }
    return covered.has(value);
  }
  function fieldMatch(grant) {
    return discMatchValue(grant, state.disc);
  }
  function disciplineText(grant) {
    return grantDisciplines(grant)
      .map(t => WILDCARD_LABEL[t] || DISC_LABEL[t])
      .filter(Boolean)
      .join(', ');
  }
  function searchText(grant) {
    if (!grant._text) {
      grant._text = [grant.name, grant.funder, grant.region, grant.amount,
        grant.description, grant.deadlineNote, disciplineText(grant)]
        .filter(Boolean).join(' ').toLowerCase();
    }
    return grant._text;
  }
  function queryMatch(grant) {
    if (!state.query) return true;
    const hay = searchText(grant);
    return state.query.split(/\s+/).every(w => hay.includes(w));
  }
  function filterMatch(grant) {
    if (!queryMatch(grant)) return false;
    if (!fieldMatch(grant)) return false;
    const f = state.filter;
    if (f === 'all') return true;
    if (f === 'hackathons') return isHackathon(grant);
    if (f === 'rolling') return isRolling(grant);
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
      cells.push(`<div class="cal-wd" aria-hidden="true">${w}</div>`);
    }
    const first = new Date(state.year, state.month, 1);
    const leading = weekdayMon(first);
    for (let i = 0; i < leading; i++) {
      cells.push('<div class="cal-cell is-blank" aria-hidden="true"></div>');
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
        .map(a => `<span class="cal-dot" data-audience="${a}"></span>`)
        .join('');
      const isPast = ymd(d) < todayKey;
      const cls = `cal-cell${isToday ? ' is-today' : ''}${isPast ? ' is-past' : ''}${dayGrants.length ? ' has-pin' : ''}`;
      const inner = `<span class="cal-num">${day}</span>${dots ? `<span class="cal-dots" aria-hidden="true">${dots}</span>` : ''}`;
      if (!dayGrants.length) {
        cells.push(`<div class="${cls}"${isToday ? ' aria-current="date"' : ''}>${inner}</div>`);
        continue;
      }
      const names = dayGrants.map(g => g.name);
      const label = `${MONTH_NAMES[state.month]} ${day}, ${state.year}: ${names.length} deadline${names.length > 1 ? 's' : ''}. ${names.join('; ')}`;
      cells.push(
        `<button type="button" class="${cls}" data-grant-ids="${dayGrants.map(g => g.id).join(',')}" data-ymd="${ymd(d)}" aria-label="${escapeHTML(label)}" title="${escapeHTML(names.join('\n'))}"${isToday ? ' aria-current="date"' : ''}>${inner}</button>`
      );
    }
    grid.innerHTML = cells.join('');
  }

  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  function jumpToGrant(idsCsv, ymdKey) {
    const ids = (idsCsv || '').split(',').filter(Boolean);
    let target = null;
    for (const id of ids) {
      target = document.getElementById(`g-month-${id}-${ymdKey}`);
      if (target) break;
    }
    if (!target) return;
    target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.classList.remove('is-flashing');
    // Force reflow so the animation restarts even if class was just toggled.
    void target.offsetWidth;
    target.classList.add('is-flashing');
    setTimeout(() => target.classList.remove('is-flashing'), 1800);
  }

  // -------- list render --------
  function daysUntil(d) {
    return Math.round((d - state.today) / 86400000);
  }
  function relativeLabel(d) {
    const n = daysUntil(d);
    if (n < 0) return { text: 'closed', cls: 'is-closed' };
    if (n === 0) return { text: 'today', cls: 'is-soon' };
    if (n === 1) return { text: 'tomorrow', cls: 'is-soon' };
    if (n <= 7) return { text: `in ${n} days`, cls: 'is-soon' };
    if (n <= 60) return { text: `in ${n} days`, cls: '' };
    return null;
  }
  function deadlineHTML(d) {
    if (!d) return '<span class="grant-deadline grant-rolling">no fixed date</span>';
    const rel = relativeLabel(d);
    const badge = rel ? ` <span class="grant-rel ${rel.cls}">${rel.text}</span>` : '';
    return `<span class="grant-deadline">${formatLong(d)}${badge}</span>`;
  }
  function grantCard(grant, withDeadline, section) {
    const aud = (grant.audience || []).join(', ');
    const metaParts = [
      grant.type === 'hackathon' ? 'Hackathon' : null,
      grant.funder,
      grant.region,
      grant.amount,
      grant.duration,
      aud ? `for ${aud}` : null
    ].filter(Boolean).map(escapeHTML);
    return `
      <article id="g-${section}-${grant.id}${withDeadline ? '-' + ymd(withDeadline) : ''}" class="grant-card">
        <div class="grant-row">
          <h4 class="grant-name"><a href="${safeURL(grant.url)}" target="_blank" rel="noopener">${escapeHTML(grant.name)}</a></h4>
          ${deadlineHTML(withDeadline)}
        </div>
        <p class="grant-meta">${metaParts.join(' &middot; ')}</p>
        <p class="grant-disc">${escapeHTML(disciplineText(grant))}</p>
        ${grant.description ? `<p class="grant-desc">${escapeHTML(grant.description)}</p>` : ''}
        ${grant.deadlineNote ? `<p class="grant-note-line">${escapeHTML(grant.deadlineNote)}</p>` : ''}
      </article>
    `;
  }

  function renderMonthList() {
    const host = document.getElementById('month-list');
    const items = expandedDeadlines(true).filter(({ date }) =>
      date.getFullYear() === state.year && date.getMonth() === state.month
    );
    if (!items.length) {
      host.innerHTML = state.filter === 'rolling'
        ? '<p class="grants-empty">These grants have no fixed date. See the list below.</p>'
        : '<p class="grants-empty">No deadlines this month for the selected filters.</p>';
      return;
    }
    host.innerHTML = items.map(({ grant, date }) => grantCard(grant, date, 'month')).join('');
  }

  function renderUpcomingList() {
    const host = document.getElementById('upcoming-list');
    const all = expandedDeadlines(false);
    const items = all.slice(0, state.shown.upcoming);
    if (!items.length) {
      host.innerHTML = state.filter === 'rolling'
        ? '<p class="grants-empty">These grants have no fixed date. See the list below.</p>'
        : '<p class="grants-empty">No upcoming fixed deadlines for the selected filters.</p>';
      return;
    }
    host.innerHTML = items.map(({ grant, date }) => grantCard(grant, date, 'upcoming')).join('') +
      moreButton('upcoming', all.length - items.length);
  }

  function renderRollingList() {
    const host = document.getElementById('rolling-list');
    const all = rollingGrants();
    const items = all.slice(0, state.shown.rolling);
    if (!items.length) {
      host.innerHTML = '<p class="grants-empty">No grants without a fixed date for the selected filters.</p>';
      return;
    }
    host.innerHTML = items.map(g => grantCard(g, null, 'rolling')).join('') +
      moreButton('rolling', all.length - items.length);
  }

  function moreButton(section, remaining) {
    if (remaining <= 0) return '';
    const n = Math.min(PAGE, remaining);
    const all = remaining > PAGE
      ? `<button type="button" class="grants-more" data-more="${section}" data-all="1">Show all ${remaining}</button>`
      : '';
    return `<div class="grants-more-row"><button type="button" class="grants-more" data-more="${section}">Show ${n} more <span class="grants-more-rest">(${remaining} remaining)</span></button>${all}</div>`;
  }
  function countMatching() {
    let n = 0;
    for (const g of state.grants) if (filterMatch(g)) n++;
    return n;
  }
  function filtersActive() {
    return state.query || state.disc !== 'all' || state.filter !== 'all';
  }
  function renderSummary() {
    const textEl = document.getElementById('grants-summary-text');
    const clearEl = document.getElementById('grants-clear');
    if (!textEl) return;
    const n = countMatching();
    const total = state.grants.length;
    const text = filtersActive()
      ? `Showing ${n} of ${total} grants.`
      : `Showing all ${total} grants.`;
    if (textEl.textContent !== text) textEl.textContent = text;
    if (clearEl) clearEl.hidden = !filtersActive();
  }
  function writeHash() {
    const params = new URLSearchParams();
    if (state.query) params.set('q', state.query);
    if (state.disc !== 'all') params.set('d', state.disc);
    if (state.filter !== 'all') params.set('a', state.filter);
    const h = params.toString();
    history.replaceState(null, '', h ? '#' + h : location.pathname + location.search);
  }
  function readHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    const q = (params.get('q') || '').trim().toLowerCase();
    const d = params.get('d') || 'all';
    const a = params.get('a') || 'all';
    state.query = q;
    const validDisc = d === 'all' || Object.prototype.hasOwnProperty.call(DISC_LABEL, d) ||
      (d.startsWith('group:') && DISC_GROUPS.some(x => 'group:' + x.id === d));
    state.disc = validDisc ? d : 'all';
    const validAud = ['all', 'students', 'postdocs', 'faculty', 'hackathons', 'rolling'];
    state.filter = validAud.includes(a) ? a : 'all';
  }
  function syncControls() {
    const input = document.getElementById('grants-search');
    if (input && input.value.trim().toLowerCase() !== state.query) input.value = state.query;
    document.querySelectorAll('.tabs-audience .tab').forEach(t => {
      const on = t.getAttribute('data-filter') === state.filter;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    updateDiscFilter();
  }
  function onFiltersChanged() {
    state.shown = { upcoming: PAGE, rolling: PAGE };
    writeHash();
    renderAll();
  }

  function renderMonth() {
    renderCalendar();
    renderMonthList();
  }
  function renderAll() {
    renderSummary();
    renderCalendar();
    renderMonthList();
    renderUpcomingList();
    renderRollingList();
  }

  // -------- wiring --------
  function discChip(value, label, count, extraClass) {
    const on = state.disc === value;
    return `<button type="button" class="disc-chip${extraClass ? ' ' + extraClass : ''}${on ? ' is-active' : ''}" data-disc="${value}" aria-pressed="${on}" title="${count} grants in total">${label}<span class="disc-count"><span class="visually-hidden">, </span>${count}</span></button>`;
  }
  function countFor(value) {
    let n = 0;
    for (const g of state.grants) if (discMatchValue(g, value)) n++;
    return n;
  }
  function renderDiscFilter() {
    const host = document.getElementById('disc-filter');
    if (!host) return;
    const rows = [`<div class="disc-row">${discChip('all', 'All disciplines', state.grants.length, 'disc-all')}</div>`];
    for (const grp of DISC_GROUPS) {
      const chips = grp.items.map(([slug, label]) => discChip(slug, label, countFor(slug))).join('');
      rows.push(`<div class="disc-row">${discChip('group:' + grp.id, grp.label, countFor('group:' + grp.id), 'disc-group')}<div class="disc-items">${chips}</div></div>`);
    }
    host.innerHTML = rows.join('');
    updateDiscFilter();
  }
  // Toggle state on the existing chips so keyboard focus stays where it is.
  function updateDiscFilter() {
    document.querySelectorAll('#disc-filter .disc-chip').forEach(b => {
      const on = b.dataset.disc === state.disc;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const label = document.getElementById('disc-current');
    if (label) label.textContent = discLabel(state.disc);
  }
  function discLabel(v) {
    if (v === 'all') return 'All disciplines';
    if (v.startsWith('group:')) {
      const grp = DISC_GROUPS.find(x => 'group:' + x.id === v);
      return grp ? grp.label : 'All disciplines';
    }
    return Object.prototype.hasOwnProperty.call(DISC_LABEL, v) ? DISC_LABEL[v] : 'All disciplines';
  }
  function wireDiscFilter() {
    const host = document.getElementById('disc-filter');
    if (!host) return;
    host.addEventListener('click', (e) => {
      const b = e.target.closest('.disc-chip');
      if (!b) return;
      const v = b.dataset.disc;
      state.disc = (v === state.disc && v !== 'all') ? 'all' : v;
      updateDiscFilter();
      onFiltersChanged();
    });
  }
  function wireTabGroup(selector, attr, key) {
    const tabs = document.querySelectorAll(selector);
    tabs.forEach(t => {
      t.addEventListener('click', () => {
        const v = t.getAttribute(attr);
        if (v === state[key]) return;
        state[key] = v;
        tabs.forEach(o => {
          const on = o === t;
          o.classList.toggle('is-active', on);
          o.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        onFiltersChanged();
      });
    });
  }
  function wireTabs() {
    wireTabGroup('.tabs-audience .tab', 'data-filter', 'filter');
  }
  function wireSearch() {
    const input = document.getElementById('grants-search');
    if (!input) return;
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.query = input.value.trim().toLowerCase();
        onFiltersChanged();
      }, 150);
    });
  }
  function wireListButtons() {
    document.addEventListener('click', (e) => {
      const more = e.target.closest('.grants-more');
      if (more) {
        const sec = more.dataset.more;
        const before = document.querySelectorAll(`#${sec}-list .grant-card`).length;
        state.shown[sec] = more.dataset.all ? Infinity : state.shown[sec] + PAGE;
        if (sec === 'upcoming') renderUpcomingList(); else renderRollingList();
        const next = document.querySelectorAll(`#${sec}-list .grant-card`)[before];
        if (next) { next.tabIndex = -1; next.focus(); }
        return;
      }
      if (e.target.closest('#grants-clear')) {
        state.query = '';
        state.disc = 'all';
        state.filter = 'all';
        syncControls();
        onFiltersChanged();
        const input = document.getElementById('grants-search');
        if (input) input.focus();
      }
    });
  }
  function wireNav() {
    document.getElementById('cal-prev').addEventListener('click', () => {
      state.month -= 1;
      if (state.month < 0) { state.month = 11; state.year -= 1; }
      renderMonth();
    });
    document.getElementById('cal-next').addEventListener('click', () => {
      state.month += 1;
      if (state.month > 11) { state.month = 0; state.year += 1; }
      renderMonth();
    });
  }
  function wireCalendarClicks() {
    const grid = document.getElementById('cal-grid');
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('button.cal-cell');
      if (!cell) return;
      jumpToGrant(cell.dataset.grantIds, cell.dataset.ymd);
    });
  }
  function onHashChange() {
    readHash();
    syncControls();
    state.shown = { upcoming: PAGE, rolling: PAGE };
    renderAll();
  }
  // Keep "today" current for tabs left open across midnight.
  function onVisibilityChange() {
    if (document.visibilityState !== 'visible') return;
    const now = startOfToday();
    if (ymd(now) === ymd(state.today)) return;
    state.today = now;
    renderAll();
  }
  function showLoadError() {
    const msg = 'Could not load the grants data. Please reload the page or try again later.';
    const summary = document.getElementById('grants-summary-text');
    if (summary) summary.textContent = msg;
    const grid = document.getElementById('cal-grid');
    if (grid) grid.innerHTML = `<p class="grants-empty">${msg}</p>`;
    for (const id of ['grants-count', 'grants-updated']) {
      const el = document.getElementById(id);
      if (el) el.textContent = '-';
    }
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

    readHash();
    renderDiscFilter();
    syncControls();
    wireDiscFilter();
    wireTabs();
    wireSearch();
    wireListButtons();
    wireNav();
    window.addEventListener('hashchange', onHashChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const panel = document.getElementById('disc-panel');
    if (panel && window.matchMedia('(min-width: 701px)').matches) panel.open = true;
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
      showLoadError();
    });
})();
