/* Quint app: polling, scoring, rendering, settings, alerts. */
(function () {
  'use strict';
  const S = window.Scoring;
  const E = window.Espn;

  /* ---------- settings ---------- */
  const KEY = 'quint.settings.v1';
  const EXTRA = { refreshSeconds: 5, notify: false, notifyMin: 110, wakeLock: false, proxy: '', openUrl: '', appLinks: '' };
  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
    const s = S.mergeSettings(saved);
    Object.keys(EXTRA).forEach((k) => { if (s[k] === undefined) s[k] = EXTRA[k]; });
    return s;
  }
  function saveSettings() { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ } }
  let settings = loadSettings();
  let chanSet = S.channelSet(settings.channels);

  function parseLinks(text) {
    const map = {};
    String(text || '').split('\n').forEach((line) => {
      const i = line.indexOf('=');
      if (i > 0) {
        const k = S.normChannel(line.slice(0, i));
        const v = line.slice(i + 1).trim();
        if (k && v) map[k] = v;
      }
    });
    return map;
  }
  let links = parseLinks(settings.appLinks);

  /* ---------- state ---------- */
  const TABS = [
    { id: 'best', label: 'Best' }, { id: 'nfl', label: 'NFL' }, { id: 'cfb', label: 'CFB' }, { id: 'mlb', label: 'MLB' },
    { id: 'nhl', label: 'NHL' }, { id: 'nba', label: 'NBA' }, { id: 'pga', label: 'PGA' }, { id: 'more', label: 'More' },
  ];
  const MIN_INTERVAL = { cfb: 10, pga: 30 }; // seconds; these feeds are the biggest
  const state = {
    tab: 'best', games: {}, wp: {}, sess: {}, sumBusy: {}, inflight: {}, nextDue: {}, diag: {}, raw: {},
    lastOk: 0, entries: [], lastHtml: '', alerted: {}, alertsArmed: false, topCand: null, lastNotifyAt: 0, startedAt: Date.now(),
  };
  const leagues = () => settings.leagues.filter((l) => E.SPORTS[l]);

  /* ---------- small helpers ---------- */
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  const fmtClockNow = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const pct = (x) => Math.round(x * 100) + '%';
  const sameDay = (iso) => { const d = new Date(iso); return !isNaN(d) && d.toDateString() === new Date().toDateString(); };

  /* ---------- fetching ---------- */
  async function fetchJson(url) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
      const text = await res.text();
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return { json: JSON.parse(text), bytes: text.length };
    } finally { clearTimeout(to); }
  }

  function errText(e) {
    if (e && e.name === 'AbortError') return 'Timed out';
    if (e && /Failed to fetch|NetworkError|Load failed/i.test(String(e.message))) return 'Blocked or offline';
    return String((e && e.message) || e);
  }

  async function fetchLeague(lg) {
    state.inflight[lg] = true;
    const t0 = performance.now();
    try {
      const urls = E.scoreboardUrls(lg, new Date(), settings.proxy);
      const results = await Promise.all(urls.map(fetchJson));
      const byId = {};
      let bytes = 0;
      results.forEach((r, i) => {
        bytes += r.bytes;
        if (i === 0 && r.json && r.json.events && r.json.events[0]) {
          try { state.raw[lg] = JSON.stringify(r.json.events[0]).slice(0, 9000); } catch (e) { /* ignore */ }
        }
        E.normalizeScoreboard(r.json, lg).forEach((g) => { if (!byId[g.id] || g.state === 'in') byId[g.id] = g; });
      });
      state.games[lg] = Object.keys(byId).map((k) => byId[k]);
      state.lastOk = Date.now();
      state.diag[lg] = { ok: true, count: state.games[lg].length, bytes, ms: Math.round(performance.now() - t0), at: Date.now() };
    } catch (e) {
      state.diag[lg] = Object.assign({}, state.diag[lg], { ok: false, error: errText(e), at: Date.now() });
    } finally {
      state.inflight[lg] = false;
      state.nextDue[lg] = Date.now() + intervalFor(lg);
      scheduleRender();
    }
  }

  function intervalFor(lg) {
    const games = state.games[lg] || [];
    const now = Date.now();
    const hot = games.some((g) => {
      if (g.state === 'in') return true;
      const st = Date.parse(g.startTime);
      return g.state === 'pre' && !isNaN(st) && st - now < 20 * 60000 && st - now > -10 * 60000;
    });
    if (hot) return Math.max(settings.refreshSeconds, MIN_INTERVAL[lg] || 0) * 1000;
    return games.length ? 60000 : 300000;
  }

  async function fetchSummary(g) {
    state.sumBusy[g.id] = true;
    try {
      const r = await fetchJson(E.summaryUrl(g.league, g.id, settings.proxy));
      const wp = E.parseWinProb(r.json);
      state.wp[g.id] = wp ? { home: wp.home, history: wp.history, fetched: Date.now() } : { none: true, fetched: Date.now() };
      const d = state.diag.summary || { ok: 0, none: 0, err: 0 };
      if (wp) d.ok++; else d.none++;
      state.diag.summary = d;
    } catch (e) {
      state.wp[g.id] = Object.assign({}, state.wp[g.id], { fetched: Date.now() });
      const d = state.diag.summary || { ok: 0, none: 0, err: 0 };
      d.err++; d.lastError = errText(e);
      state.diag.summary = d;
    } finally {
      state.sumBusy[g.id] = false;
      scheduleRender();
    }
  }

  function maybeFetchSummaries(entries) {
    const now = Date.now();
    let busy = Object.keys(state.sumBusy).filter((k) => state.sumBusy[k]).length;
    S.rankLive(entries, settings).filter((e) => e.g.kind === 'team').slice(0, 6).forEach((e) => {
      const id = e.g.id;
      const info = state.wp[id] || {};
      if (state.sumBusy[id] || busy >= 3) return;
      if (info.none && now - info.fetched < 300000) return;
      if (now - (info.fetched || 0) < 20000) return;
      busy++;
      fetchSummary(e.g);
    });
  }

  function tick() {
    if (document.hidden) return;
    const now = Date.now();
    leagues().forEach((lg) => {
      if (!state.inflight[lg] && now >= (state.nextDue[lg] || 0)) fetchLeague(lg);
    });
    if (state.entries.length) maybeFetchSummaries(state.entries);
    updateMeta();
  }
  function kick() { Object.keys(E.SPORTS).forEach((lg) => { state.nextDue[lg] = 0; }); tick(); }

  /* ---------- scoring ---------- */
  function wpFor(g) {
    const info = state.wp[g.id];
    const sess = state.sess[g.id] || [];
    if (info && info.home != null && Date.now() - info.fetched < 75000) {
      return { home: info.home, source: 'espn', history: info.history && info.history.length > 5 ? info.history : sess };
    }
    return { home: null, history: info && info.history && info.history.length > 5 ? info.history : sess };
  }
  function pushSess(id, v) {
    const a = state.sess[id] || (state.sess[id] = []);
    if (!a.length || Math.abs(a[a.length - 1] - v) >= 0.01) { a.push(v); if (a.length > 300) a.shift(); }
  }
  function computeAll() {
    const out = [];
    leagues().forEach((lg) => {
      (state.games[lg] || []).forEach((g) => {
        const s = S.scoreGame(g, { settings, channelSet: chanSet, wp: wpFor(g) });
        if (s.wp && g.state === 'in') pushSess(g.id, s.wp.home);
        out.push({ g, s });
      });
    });
    return out;
  }

  /* ---------- rendering pieces ---------- */
  function logo(t) {
    if (t.logo) return '<img class="logo" src="' + esc(t.logo) + '" alt="" loading="lazy">';
    return '<div class="ph">' + esc((t.abbr || t.shortName || '').slice(0, 3)) + '</div>';
  }
  function reasonChips(s, max) {
    const good = s.reasons.filter((r) => r.kind !== 'avail' && r.kind !== 'sport' && r.kind !== 'penalty' && r.pts > 0).sort((a, b) => b.pts - a.pts).slice(0, max);
    const bad = s.reasons.filter((r) => r.kind === 'penalty');
    return good.concat(bad).map((r) => '<span class="chip' + (r.kind === 'fav' ? ' fav' : '') + '">' + esc(r.label) + '<span class="p">' + (r.pts > 0 ? '+' : '') + r.pts + '</span></span>').join('');
  }
  function mineChannels(g) { return (g.broadcasts || []).filter((b) => chanSet.has(S.normChannel(b))); }
  function channelLine(g) {
    if (!g.broadcasts || !g.broadcasts.length) return '<span class="ch">Channel not listed yet</span>';
    const mine = mineChannels(g);
    if (mine.length) return '<span class="ch">On <b>' + esc(mine.join(', ')) + '</b></span>';
    return '<span class="ch">Not on your channels: <b>' + esc(g.broadcasts.join(', ')) + '</b></span>';
  }
  function openUrlFor(g) {
    const mine = mineChannels(g);
    for (let i = 0; i < mine.length; i++) { const u = links[S.normChannel(mine[i])]; if (u) return u; }
    return settings.openUrl || '';
  }
  function statusLabel(g) {
    if (g.postponed) return 'Postponed';
    if (g.state === 'pre') return fmtTime(g.startTime);
    return g.statusText || (g.state === 'post' ? 'Final' : 'Live');
  }

  function heroTeam(t, lead) {
    return '<div class="side' + (lead ? ' lead' : '') + '">' + logo(t) +
      '<div><div class="nm">' + esc(t.shortName) + '</div><div class="rc">' + (t.rank ? 'No. ' + t.rank + ' ' : '') + esc(t.record) + '</div></div>' +
      '<div class="sc">' + esc(t.score) + '</div></div>';
  }

  function meter(g, s) {
    const lo = ((1 - settings.wpClose) * 100).toFixed(0) + '%';
    const hi = (settings.wpClose * 100).toFixed(0) + '%';
    const home = s.wp.home;
    const cap = s.wp.source === 'est' ? 'Estimated from score and clock' : 'Win probability from ESPN';
    return '<div class="meter" style="--lo:' + lo + ';--hi:' + hi + '">' +
      '<div class="track"><span class="mid"></span><span class="pin" style="left:' + (home * 100).toFixed(1) + '%"></span></div>' +
      '<div class="lbl"><span><b>' + esc(g.away.abbr) + '</b> ' + pct(1 - home) + '</span><span class="cap">' + cap + '</span><span><b>' + esc(g.home.abbr) + '</b> ' + pct(home) + '</span></div></div>';
  }

  function watchRow(g, s) {
    const url = s.available === true ? openUrlFor(g) : '';
    return '<div class="watch">' + channelLine(g) + (url ? '<a class="btn primary" href="' + esc(url) + '">Open app</a>' : '') + '</div>';
  }

  function hero(e) {
    const g = e.g, s = e.s;
    if (g.kind === 'golf') return heroGolf(e);
    const L = S.LEAGUES[g.league];
    const awayLead = g.away.score > g.home.score, homeLead = g.home.score > g.away.score;
    return '<article class="hero">' +
      '<div class="hero-top"><span>' + esc(L.label) + '</span><span class="st"><span class="dot"></span>' + esc(statusLabel(g)) + '</span></div>' +
      heroTeam(g.away, awayLead) + heroTeam(g.home, homeLead) +
      meter(g, s) +
      '<div class="chips why">' + reasonChips(s, 4) + '</div>' +
      watchRow(g, s) + '</article>';
  }

  function heroGolf(e) {
    const g = e.g, s = e.s;
    const rows = (g.golf.leaders || []).slice(0, 5).map((p) => '<tr><td>' + esc(p.pos) + '</td><td class="lead">' + esc(p.name) + '</td><td class="r">' + esc(p.scoreText || '') + '</td><td class="r">' + esc(p.thru === null || p.thru === undefined ? '' : p.thru) + '</td></tr>').join('');
    return '<article class="hero"><div class="hero-top"><span>PGA Tour</span><span class="st"><span class="dot"></span>' + esc(g.statusText) + '</span></div>' +
      '<div class="nm" style="margin-top:10px;font:700 22px/1.1 var(--display)">' + esc(g.name) + '</div>' +
      '<table class="lb"><tbody>' + rows + '</tbody></table>' +
      '<div class="chips why">' + reasonChips(s, 4) + '</div>' + watchRow(g, s) + '</article>';
  }

  function rankItem(e, i) {
    const g = e.g, s = e.s;
    let title, sub;
    if (g.kind === 'golf') {
      title = g.name;
      const l = (g.golf.leaders || [])[0];
      sub = (l ? 'Leader ' + l.name + ' ' + (l.scoreText || '') : '') + ' ' + g.statusText;
    } else {
      title = g.away.shortName + ' at ' + g.home.shortName;
      sub = g.away.abbr + ' ' + g.away.score + ', ' + g.home.abbr + ' ' + g.home.score + '. ' + statusLabel(g);
    }
    return '<li><span class="pos">' + (i + 2) + '</span><div><div class="mt">' + esc(title) + '</div><div class="sub">' + esc(sub.trim()) + '</div>' +
      '<div class="chips">' + reasonChips(s, 2) + '</div><div class="sub" style="margin-top:6px">' + channelLine(g) + '</div></div>' +
      '<div class="pts">' + s.score + '<small>points</small></div></li>';
  }

  function upcomingList(entries, max) {
    const now = Date.now();
    return entries.filter((e) => e.g.state === 'pre' && !e.g.postponed && Date.parse(e.g.startTime) > now - 15 * 60000)
      .sort((a, b) => {
        const fa = isFavEntry(a) ? 0 : 1, fb = isFavEntry(b) ? 0 : 1;
        return fa - fb || Date.parse(a.g.startTime) - Date.parse(b.g.startTime);
      }).slice(0, max);
  }
  function isFavEntry(e) {
    const g = e.g;
    return g.kind === 'team' && (S.isFavorite(g.home, g.league, settings.favorites) || S.isFavorite(g.away, g.league, settings.favorites));
  }

  function feedProblems() {
    const bad = leagues().filter((lg) => state.diag[lg] && state.diag[lg].ok === false && !(state.games[lg] || []).length);
    return bad.map((lg) => lg.toUpperCase() + ': ' + state.diag[lg].error);
  }

  function renderBest(entries) {
    const ranked = S.rankLive(entries, settings).slice(0, 5);
    const problems = feedProblems();
    let html = '';
    if (problems.length && !entries.length) {
      return '<div class="notice"><b>Can\'t reach ESPN.</b> ' + esc(problems[0]) + '. Open More, then Data, to see the details or set a proxy.</div>' +
        '<div class="empty"><b>No data yet</b>Quint will keep trying.</div>';
    }
    if (!entries.length && !Object.keys(state.diag).length) return '<div class="empty"><b>Loading games</b>Checking every league for today.</div>';
    if (ranked.length) {
      html += hero(ranked[0]);
      if (ranked.length > 1) html += '<h2 class="sec">Also worth a look</h2><ol class="rank">' + ranked.slice(1).map(rankItem).join('') + '</ol>';
      return html;
    }
    html += '<div class="empty"><b>Nothing worth watching right now</b>No live game is close enough or on your teams. Quint checks again every few seconds.</div>';
    const next = upcomingList(entries, 4);
    if (next.length) {
      html += '<h2 class="sec next">Up next</h2>' + next.map(gameRow).join('');
    }
    return html;
  }

  function teamRow(t, lose, showScore) {
    return '<div class="row' + (lose ? ' lose' : '') + '">' + logo(t) +
      '<div class="tn">' + (t.rank ? '<span class="rk">' + t.rank + '</span>' : '') + esc(t.shortName) + '<span class="rec">' + esc(t.record) + '</span></div>' +
      '<div class="sc">' + (showScore ? esc(t.score) : '') + '</div></div>';
  }

  function gameRow(e) {
    const g = e.g, s = e.s;
    if (g.kind === 'golf') return golfCard(e);
    const live = g.state === 'in', post = g.state === 'post', pre = g.state === 'pre';
    const showScore = !pre;
    const awayLose = post && g.home.score > g.away.score, homeLose = post && g.away.score > g.home.score;
    let chips = '';
    if (live) {
      chips = reasonChips(s, 3);
      if (s.excluded) chips += '<span class="chip no">Out of Best: ' + esc(s.excludeReason) + '</span>';
    }
    let odds = '';
    if (pre && g.odds && (g.odds.text || g.odds.overUnder)) {
      odds = '<div class="odds">' + (g.odds.text ? 'Line ' + esc(g.odds.text) : '') + (g.odds.overUnder ? (g.odds.text ? ', ' : '') + 'total ' + esc(g.odds.overUnder) : '') + '</div>';
    }
    return '<article class="game' + (live && s.excluded ? ' dim' : '') + '">' +
      teamRow(g.away, awayLose, showScore) + teamRow(g.home, homeLose, showScore) +
      '<div class="foot"><span class="st' + (live ? ' live' : '') + '">' + (live ? '<span class="dot"></span>' : '') + esc(statusLabel(g)) + '</span>' + channelLine(g) + '</div>' +
      (chips ? '<div class="chips">' + chips + '</div>' : '') + odds + '</article>';
  }

  function golfCard(e) {
    const g = e.g, s = e.s;
    const rows = (g.golf.leaders || []).slice(0, 12).map((p) => '<tr><td>' + esc(p.pos) + '</td><td' + (p.pos === 1 ? ' class="lead"' : '') + '>' + esc(p.name) + '</td><td class="r">' + esc(p.scoreText || '') + '</td><td class="r">' + esc(p.thru === null || p.thru === undefined ? '' : p.thru) + '</td></tr>').join('');
    return '<article class="event"><h3>' + esc(g.name) + '</h3>' +
      '<div class="small">' + (g.state === 'in' ? '<span class="dot"></span>' : '') + esc(g.statusText) + '</div>' +
      '<div class="foot" style="border:0;margin:6px 0 0;padding:0">' + channelLine(g) + '</div>' +
      (g.state === 'in' ? '<div class="chips">' + reasonChips(s, 3) + '</div>' : '') +
      (rows ? '<table class="lb"><tbody>' + rows + '</tbody></table>' : '<p class="small">Leaderboard not posted yet.</p>') + '</article>';
  }

  function visible(g) {
    if (g.state === 'in') return true;
    if (g.kind === 'golf') {
      const end = Date.parse(g.endTime);
      return g.state !== 'post' || (!isNaN(end) && Date.now() - end < 36 * 3600 * 1000);
    }
    return sameDay(g.startTime);
  }

  function renderLeague(lg, entries) {
    const L = S.LEAGUES[lg];
    const list = entries.filter((e) => e.g.league === lg && visible(e.g));
    const dg = state.diag[lg];
    if (!list.length) {
      if (dg && dg.ok === false) return '<div class="notice"><b>' + esc(L.short) + ' feed failed.</b> ' + esc(dg.error) + '.</div>';
      return '<div class="empty"><b>No ' + esc(L.label) + ' today</b>' + (dg ? 'The schedule is empty for today.' : 'Loading.') + '</div>';
    }
    const live = list.filter((e) => e.g.state === 'in').sort((a, b) => (a.s.excluded ? 1 : 0) - (b.s.excluded ? 1 : 0) || S.cmp(a, b));
    const pre = list.filter((e) => e.g.state === 'pre').sort((a, b) => Date.parse(a.g.startTime) - Date.parse(b.g.startTime));
    const post = list.filter((e) => e.g.state === 'post').sort((a, b) => Date.parse(b.g.startTime) - Date.parse(a.g.startTime));
    let html = '';
    if (live.length) html += '<h2 class="sec">Live now</h2>' + live.map(gameRow).join('');
    if (pre.length) html += '<h2 class="sec">' + (lg === 'pga' ? 'Upcoming' : 'Later today') + '</h2>' + pre.map(gameRow).join('');
    if (post.length) html += '<h2 class="sec">Finished</h2>' + post.map(gameRow).join('');
    return html;
  }

  /* ---------- More tab (settings + diagnostics) ---------- */
  const REFRESH_OPTIONS = [[3, 'Every 3 seconds'], [5, 'Every 5 seconds'], [10, 'Every 10 seconds'], [15, 'Every 15 seconds'], [30, 'Every 30 seconds'], [60, 'Every minute']];

  function renderMore() {
    const opts = REFRESH_OPTIONS.map((o) => '<option value="' + o[0] + '"' + (o[0] === settings.refreshSeconds ? ' selected' : '') + '>' + o[1] + '</option>').join('');
    const notifSupported = 'Notification' in window;
    return '' +
      '<section class="set"><h3>Your teams</h3><p>League and abbreviation, separated by commas. A game with one of these gets a big boost and is never filtered as a blowout.</p>' +
      '<label for="f-fav">Favorite teams</label><input type="text" id="f-fav" value="' + esc(settings.favorites.join(', ')) + '" autocapitalize="off" autocomplete="off"></section>' +

      '<section class="set"><h3>Channels you get</h3><p>Games on these channels score higher. Games on anything else are marked down but still listed. The Data section below shows the channel names ESPN used today so you can copy them exactly.</p>' +
      '<label for="f-ch">Channels</label><input type="text" id="f-ch" value="' + esc(settings.channels.join(', ')) + '" autocomplete="off"></section>' +

      '<section class="set"><h3>Refresh</h3><p>Quint only refreshes fast for leagues with a live game. Everything else refreshes about once a minute. College football and golf have the biggest feeds, so they never refresh faster than every 10 and 30 seconds.</p>' +
      '<label for="f-rf">Live refresh</label><select id="f-rf">' + opts + '</select>' +
      '<label class="inline"><input type="checkbox" id="f-wake"' + (settings.wakeLock ? ' checked' : '') + '> Keep the screen awake while Quint is open</label></section>' +

      '<section class="set"><h3>Alerts</h3><p>' + (notifSupported ? 'Alerts arrive only while Quint is open on your phone. On iPhone, add Quint to your Home Screen first, then turn this on from the Home Screen app.' : 'This browser does not support notifications.') + '</p>' +
      '<label class="inline"><input type="checkbox" id="f-notify"' + (settings.notify ? ' checked' : '') + (notifSupported ? '' : ' disabled') + '> Alert me when a Boston game starts or a new best game takes over</label>' +
      '<label for="f-nmin">Alert for non-Boston games scoring at least</label><input type="number" id="f-nmin" value="' + esc(settings.notifyMin) + '">' +
      '<div class="actions"><button class="btn" id="b-testnotify" type="button">Send a test alert</button></div></section>' +

      '<section class="set"><h3>Ranking</h3><p>A game only counts as close while the leader\'s win probability is under the first number. At or above the second number it is treated as garbage time and left out of Best.</p>' +
      '<label for="f-wpc">Close means win probability under (percent)</label><input type="number" id="f-wpc" min="55" max="95" value="' + Math.round(settings.wpClose * 100) + '">' +
      '<label for="f-wpb">Blowout at or above (percent)</label><input type="number" id="f-wpb" min="85" max="100" value="' + Math.round(settings.wpBlowout * 100) + '">' +
      '<label class="inline"><input type="checkbox" id="f-exempt"' + (settings.favoritesExemptFromExclusion ? ' checked' : '') + '> Never filter out blowouts involving my teams</label>' +
      '<details style="margin-top:10px"><summary>Point values (advanced)</summary><label for="f-w">Weights as JSON</label><textarea id="f-w" spellcheck="false">' + esc(JSON.stringify(settings.weights, null, 2)) + '</textarea>' +
      '<div class="actions"><button class="btn" id="b-resetw" type="button">Reset point values</button></div></details>' +
      '<details style="margin-top:10px"><summary>How the points work</summary><p class="small" style="margin-top:8px">Your teams: +300 each. NBA games without the Celtics: -1000. On your channels: +40, otherwise -60. Sport bump: NFL +15, college football +10, NHL +10. Close game: up to +60 depending on how uncertain the win probability is, counting more as the game goes on. One score late: +25. Overtime or extra innings: +35 and more for each extra period. Comeback in progress: up to +30. Upset brewing: +15 to +30. Ranked vs ranked in college football: +30, +20 more if both are top 10. Playoffs: +40, championship round +20. Rivalry: +15. Ties go to the smaller margin, then the later point in the game.</p></details></section>' +

      '<section class="set"><h3>Open app</h3><p>The Open app button appears on games you can watch. Paste the link that opens your streaming app. One link per line below adds a different link per channel.</p>' +
      '<label for="f-open">Default link</label><input type="text" id="f-open" value="' + esc(settings.openUrl) + '" placeholder="Link that opens your streaming app" autocapitalize="off" autocomplete="off">' +
      '<label for="f-links">Per channel (CHANNEL=link)</label><textarea id="f-links" spellcheck="false" placeholder="NESN=...">' + esc(settings.appLinks) + '</textarea></section>' +

      '<section class="set"><h3>Data</h3><p>Where Quint is reading from, and what it got back on the last pass.</p>' +
      '<label for="f-proxy">Proxy (only if ESPN is blocked on your network)</label><input type="text" id="f-proxy" value="' + esc(settings.proxy) + '" placeholder="https://your-proxy.example/?url={url}" autocapitalize="off" autocomplete="off">' +
      '<div id="diag" style="margin-top:12px"></div>' +
      '<div class="actions"><button class="btn" id="b-refresh" type="button">Refresh now</button><button class="btn" id="b-copyraw" type="button">Copy ESPN samples</button><button class="btn" id="b-copydiag" type="button">Copy diagnostics</button></div><p class="small" id="copyout"></p></section>' +

      '<div class="actions" style="margin-bottom:24px"><button class="btn primary" id="b-save" type="button">Save changes</button><span class="small" id="saveout" role="status"></span></div>';
  }

  function diagHtml() {
    const rows = leagues().map((lg) => {
      const d = state.diag[lg];
      const games = state.games[lg] || [];
      const live = games.filter((g) => g.state === 'in').length;
      if (!d) return '<tr><td>' + lg.toUpperCase() + '</td><td colspan="4">Waiting</td></tr>';
      return '<tr><td>' + lg.toUpperCase() + '</td><td class="' + (d.ok ? 'good' : 'bad') + '">' + (d.ok ? 'OK' : esc(d.error)) + '</td><td>' + live + ' live of ' + games.length + '</td><td>' + (d.bytes != null ? Math.round(d.bytes / 1024) + ' kB' : '') + '</td><td>' + (d.ms != null ? d.ms + ' ms' : '') + '</td></tr>';
    }).join('');
    const sm = state.diag.summary;
    const seen = {};
    Object.keys(state.games).forEach((lg) => (state.games[lg] || []).forEach((g) => (g.broadcasts || []).forEach((b) => { seen[b] = (seen[b] || 0) + 1; })));
    const names = Object.keys(seen).sort().map((b) => '<span class="chip ' + (chanSet.has(S.normChannel(b)) ? 'ok' : 'no') + '">' + esc(b) + '</span>').join(' ');
    return '<table class="diag"><thead><tr><th>Feed</th><th>Status</th><th>Games</th><th>Size</th><th>Time</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="small" style="margin-top:10px">ESPN win probability: ' + (sm ? sm.ok + ' games with it, ' + sm.none + ' without, ' + sm.err + ' failed' + (sm.lastError ? ' (' + esc(sm.lastError) + ')' : '') : 'not requested yet') + '. Games without it use an estimate from the score and clock.</p>' +
      '<p class="small">Channel names ESPN listed today (green means yours):</p><div class="chips">' + (names || '<span class="small">None yet</span>') + '</div>';
  }
  function updateDiag() { const el = document.getElementById('diag'); if (el) el.innerHTML = diagHtml(); }

  function readForm() {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
    const chk = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
    const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
    const next = Object.assign({}, settings);
    next.favorites = list(val('f-fav'));
    next.channels = list(val('f-ch'));
    next.refreshSeconds = Math.max(2, parseInt(val('f-rf'), 10) || 5);
    next.wakeLock = chk('f-wake');
    next.notify = chk('f-notify');
    next.notifyMin = parseInt(val('f-nmin'), 10) || 110;
    next.wpClose = Math.min(0.95, Math.max(0.55, (parseInt(val('f-wpc'), 10) || 80) / 100));
    next.wpBlowout = Math.min(1, Math.max(0.85, (parseInt(val('f-wpb'), 10) || 97) / 100));
    next.favoritesExemptFromExclusion = chk('f-exempt');
    next.openUrl = (val('f-open') || '').trim();
    next.appLinks = val('f-links') || '';
    next.proxy = (val('f-proxy') || '').trim();
    const wtxt = val('f-w');
    if (wtxt != null) next.weights = S.mergeSettings({ weights: JSON.parse(wtxt) }).weights;
    return next;
  }

  async function saveForm() {
    const out = document.getElementById('saveout');
    let next;
    try { next = readForm(); } catch (e) { out.textContent = 'Point values are not valid JSON: ' + e.message; out.className = 'small bad'; return; }
    const wasNotify = settings.notify;
    const proxyChanged = next.proxy !== settings.proxy;
    settings = next;
    chanSet = S.channelSet(settings.channels);
    links = parseLinks(settings.appLinks);
    saveSettings();
    if (settings.notify && !wasNotify) await ensureNotifyPermission();
    setWake(settings.wakeLock);
    if (proxyChanged) { state.games = {}; state.wp = {}; }
    out.textContent = 'Saved';
    out.className = 'small good';
    kick();
  }

  /* ---------- alerts ---------- */
  async function ensureNotifyPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') { settings.notify = false; saveSettings(); return false; }
    const p = await Notification.requestPermission();
    if (p !== 'granted') { settings.notify = false; saveSettings(); }
    return p === 'granted';
  }
  async function sendNotification(title, body, tag) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return false;
    try {
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      const opts = { body, tag, icon: 'icon-192.png', badge: 'icon-192.png' };
      if (reg) await reg.showNotification(title, opts); else new Notification(title, opts);
      return true;
    } catch (e) { return false; }
  }
  function describe(e) {
    const g = e.g;
    if (g.kind === 'golf') return g.name + ' (' + g.statusText + ')';
    return g.away.shortName + ' at ' + g.home.shortName + ', ' + g.away.score + '-' + g.home.score + ', ' + statusLabel(g);
  }
  function checkAlerts(entries) {
    if (!settings.notify) return;
    const live = entries.filter((e) => e.s && !e.s.inactive);
    if (!state.alertsArmed) {
      if (Date.now() - state.startedAt > 12000) { live.forEach((e) => { state.alerted[e.g.id] = Date.now(); }); state.alertsArmed = true; }
      return;
    }
    const now = Date.now();
    /* Boston game just started */
    live.filter((e) => e.s.reasons.some((r) => r.kind === 'fav')).forEach((e) => {
      if (!state.alerted[e.g.id]) {
        state.alerted[e.g.id] = now;
        sendNotification('Your team is on', describe(e), 'fav-' + e.g.id);
      }
    });
    /* a new non-Boston best game has held the top spot for 20 seconds */
    const top = S.rankLive(entries, settings)[0];
    if (!top || top.s.reasons.some((r) => r.kind === 'fav') || top.s.score < settings.notifyMin) { state.topCand = null; return; }
    if (!state.topCand || state.topCand.id !== top.g.id) { state.topCand = { id: top.g.id, since: now }; return; }
    const last = state.alerted[top.g.id] || 0;
    if (now - state.topCand.since >= 20000 && now - last > 20 * 60000 && now - state.lastNotifyAt > 3 * 60000) {
      state.alerted[top.g.id] = now; state.lastNotifyAt = now;
      sendNotification('Best game on', describe(top), 'best');
    }
  }

  /* ---------- wake lock ---------- */
  let wl = null;
  async function setWake(on) {
    try {
      if (on && 'wakeLock' in navigator && !wl) { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); }
      else if (!on && wl) { await wl.release(); wl = null; }
    } catch (e) { /* not supported or denied */ }
  }

  /* ---------- main render ---------- */
  let raf = 0;
  function scheduleRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

  function renderTabs(entries) {
    const counts = {};
    entries.forEach((e) => { if (e.g.state === 'in') counts[e.g.league] = (counts[e.g.league] || 0) + 1; });
    const nav = document.getElementById('tabs');
    nav.setAttribute('role', 'tablist');
    nav.innerHTML = TABS.map((t) => {
      const n = t.id === 'best' ? S.rankLive(entries, settings).length : counts[t.id];
      return '<button class="tab" role="tab" data-tab="' + t.id + '" aria-selected="' + (state.tab === t.id) + '">' + t.label + (n ? '<span class="n">' + n + '</span>' : '') + '</button>';
    }).join('');
  }

  function render() {
    const entries = computeAll();
    state.entries = entries;
    renderTabs(entries);
    const view = document.getElementById('view');
    if (state.tab === 'more') {
      if (!view.querySelector('#diag')) { view.innerHTML = renderMore(); state.lastHtml = ''; bindMore(); }
      updateDiag();
    } else {
      const html = state.tab === 'best' ? renderBest(entries) : renderLeague(state.tab, entries);
      if (html !== state.lastHtml) { view.innerHTML = html; state.lastHtml = html; }
    }
    updateMeta();
    checkAlerts(entries);
  }

  function updateMeta() {
    const el = document.getElementById('meta');
    if (!el) return;
    const liveCount = (state.entries || []).filter((e) => e.g.state === 'in').length;
    let txt;
    if (!state.lastOk) {
      const bad = feedProblems();
      txt = bad.length ? 'Can\'t reach ESPN' : 'Loading games';
    } else {
      const stale = Date.now() - state.lastOk > 90000;
      txt = '<span class="dot' + (liveCount ? '' : ' idle') + '"></span>' + liveCount + ' live, ' + (stale ? 'last update ' : 'updated ') + fmtClockNow(state.lastOk);
    }
    if (el.innerHTML !== txt) el.innerHTML = txt;
  }

  function bindMore() {
    const $ = (id) => document.getElementById(id);
    $('b-save').addEventListener('click', saveForm);
    $('b-refresh').addEventListener('click', () => { kick(); });
    $('b-resetw').addEventListener('click', () => { $('f-w').value = JSON.stringify(S.DEFAULT_WEIGHTS, null, 2); });
    $('b-testnotify').addEventListener('click', async () => {
      const ok = await ensureNotifyPermission();
      const sent = ok && await sendNotification('Quint test', 'Alerts are working while Quint is open.', 'test');
      $('saveout').textContent = sent ? 'Test alert sent' : 'Alerts are blocked or unsupported here';
      $('saveout').className = 'small ' + (sent ? 'good' : 'bad');
    });
    const copy = async (text, msg) => {
      try { await navigator.clipboard.writeText(text); $('copyout').textContent = msg; }
      catch (e) { $('copyout').textContent = 'Copy failed. Your browser blocked clipboard access.'; }
    };
    $('b-copyraw').addEventListener('click', () => copy(JSON.stringify(state.raw, null, 1), 'Copied one raw ESPN game per league.'));
    $('b-copydiag').addEventListener('click', () => copy(JSON.stringify({ ua: navigator.userAgent, diag: state.diag, games: Object.keys(state.games).map((k) => k + ':' + state.games[k].length) }, null, 1), 'Copied diagnostics.'));
  }

  /* ---------- boot ---------- */
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('.tab');
    if (!b) return;
    state.tab = b.getAttribute('data-tab');
    state.lastHtml = '';
    const v = document.getElementById('view');
    if (state.tab !== 'more') v.innerHTML = '';
    else v.innerHTML = '';
    render();
    window.scrollTo(0, 0);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (settings.wakeLock) setWake(true); kick(); } });
  window.addEventListener('online', kick);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works without it */ });
  }
  render();
  setWake(settings.wakeLock);
  setInterval(tick, 500);
  tick();

  window.__quint = { state, S, E, get settings() { return settings; }, render, computeAll };
})();
