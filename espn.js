/* Quint: ESPN data layer.
 * Turns ESPN's public scoreboard / summary JSON into the flat game objects the scorer uses.
 * Every field read is defensive: ESPN's feeds are unofficial and vary a little by sport.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Espn = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BASE = 'https://site.api.espn.com/apis/site/v2/sports/';
  const SPORTS = {
    nfl: { path: 'football/nfl', params: '' },
    cfb: { path: 'football/college-football', params: 'groups=80&limit=200' },
    mlb: { path: 'baseball/mlb', params: '' },
    nhl: { path: 'hockey/nhl', params: '' },
    nba: { path: 'basketball/nba', params: '' },
    pga: { path: 'golf/pga', params: '', noDate: true },
  };
  const SD = { nfl: 13.5, cfb: 15.5, nhl: 2.45, mlb: 4.3, nba: 12 };

  const get = (o, path, def) => {
    let cur = o;
    for (const k of String(path).split('.')) {
      if (cur == null) return def;
      cur = cur[k];
    }
    return cur == null ? def : cur;
  };
  const num = (x) => { const n = parseFloat(x); return isNaN(n) ? 0 : n; };
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());

  function withProxy(url, proxy) {
    if (!proxy) return url;
    return proxy.indexOf('{url}') >= 0 ? proxy.replace('{url}', encodeURIComponent(url)) : proxy + url;
  }

  /* One scoreboard URL per date we need. Between midnight and 6am we also ask for yesterday, so late games still show. */
  function scoreboardUrls(league, now, proxy) {
    const cfg = SPORTS[league];
    const mk = (dateStr) => {
      const q = [cfg.params, dateStr ? 'dates=' + dateStr : ''].filter(Boolean).join('&');
      return withProxy(BASE + cfg.path + '/scoreboard' + (q ? '?' + q : ''), proxy);
    };
    if (cfg.noDate) return [mk('')];
    const urls = [mk(ymd(now))];
    if (now.getHours() < 6) {
      const y = new Date(now.getTime() - 24 * 3600 * 1000);
      urls.push(mk(ymd(y)));
    }
    return urls;
  }
  function summaryUrl(league, eventId, proxy) {
    return withProxy(BASE + SPORTS[league].path + '/summary?event=' + encodeURIComponent(eventId), proxy);
  }

  /* ---------- pieces ---------- */
  function pickRecord(records) {
    if (!Array.isArray(records) || !records.length) return '';
    const r = records.find((x) => x && (x.type === 'total' || x.name === 'overall' || x.name === 'All Splits')) || records[0];
    return (r && (r.summary || r.displayValue)) || '';
  }

  function normTeam(c) {
    const t = c.team || {};
    const rankRaw = get(c, 'curatedRank.current', null);
    return {
      id: t.id,
      abbr: t.abbreviation || '',
      name: t.name || t.shortDisplayName || t.displayName || '',
      shortName: t.shortDisplayName || t.name || t.displayName || '',
      location: t.location || '',
      displayName: t.displayName || '',
      logo: t.logo || get(t, 'logos.0.href', ''),
      score: num(c.score),
      record: pickRecord(c.records),
      rank: typeof rankRaw === 'number' && rankRaw > 0 && rankRaw <= 25 ? rankRaw : null,
      winner: !!c.winner,
    };
  }

  function collectBroadcasts(comp, event) {
    const names = new Set();
    const addName = (n) => { if (n && typeof n === 'string') names.add(n.trim()); };
    [comp, event].forEach((src) => {
      if (!src) return;
      (src.broadcasts || []).forEach((b) => {
        if (typeof b === 'string') addName(b);
        else if (b) {
          (b.names || []).forEach(addName);
          if (b.media) addName(b.media.shortName || b.media.name);
          if (b.name) addName(b.name);
        }
      });
      (src.geoBroadcasts || []).forEach((b) => addName(get(b, 'media.shortName', '') || get(b, 'media.name', '')));
      if (typeof src.broadcast === 'string') addName(src.broadcast);
    });
    return Array.from(names);
  }

  function mlProb(ml) {
    const n = parseFloat(String(ml).replace('+', ''));
    if (isNaN(n) || n === 0) return null;
    return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
  }
  function normCdf(z) {
    const s = Math.sign(z); z = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * z);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return 0.5 * (1 + s * y);
  }

  function normOdds(comp, league, home, away) {
    const o = (comp.odds || [])[0];
    if (!o) return null;
    const ho = o.homeTeamOdds || {};
    const ao = o.awayTeamOdds || {};
    const hml = ho.moneyLine != null ? ho.moneyLine : get(o, 'moneyline.home.close.odds', null);
    const aml = ao.moneyLine != null ? ao.moneyLine : get(o, 'moneyline.away.close.odds', null);
    const ph = mlProb(hml), pa = mlProb(aml);
    let favoriteSide = ho.favorite ? 'home' : ao.favorite ? 'away' : null;
    let favProb = null;
    if (ph != null && pa != null) {
      const tot = ph + pa;
      const nh = ph / tot, na = pa / tot;
      favProb = Math.max(nh, na);
      if (!favoriteSide) favoriteSide = nh >= na ? 'home' : 'away';
    }
    let spread = Math.abs(num(o.spread));
    if (!favoriteSide && o.details) {
      const m = String(o.details).match(/^(.+?)\s+(-\d+(?:\.\d+)?)\s*$/);
      if (m) {
        const ab = m[1].trim().toLowerCase();
        if (ab === String(home.abbr).toLowerCase()) favoriteSide = 'home';
        else if (ab === String(away.abbr).toLowerCase()) favoriteSide = 'away';
        if (!spread) spread = Math.abs(parseFloat(m[2]));
      }
    }
    /* football: spreads are meaningful, so derive a favorite probability from them when moneylines are missing */
    if (favProb == null && favoriteSide && (league === 'nfl' || league === 'cfb') && spread) {
      favProb = normCdf(spread / SD[league]);
    }
    return {
      text: o.details || '',
      overUnder: o.overUnder != null ? o.overUnder : null,
      favoriteSide,
      favProb,
    };
  }

  const CHAMP_RE = /championship|super bowl|world series|stanley cup|finals?\b|national title|cfp/i;

  /* ---------- scoreboard to games ---------- */
  function normalizeScoreboard(json, league) {
    const events = (json && json.events) || [];
    const out = [];
    events.forEach((ev) => {
      try {
        const g = league === 'pga' ? normGolfEvent(ev) : normTeamEvent(ev, league);
        if (g) out.push(g);
      } catch (e) {
        /* skip a malformed event rather than break the whole feed */
      }
    });
    return out;
  }

  function statusOf(ev, comp) {
    const st = comp.status || ev.status || {};
    const type = st.type || {};
    return { st, type, name: String(type.name || ''), state: type.state || 'pre' };
  }

  function normTeamEvent(ev, league) {
    const comp = (ev.competitions && ev.competitions[0]) || null;
    if (!comp) return null;
    const cs = comp.competitors || [];
    const hc = cs.find((c) => c.homeAway === 'home');
    const ac = cs.find((c) => c.homeAway === 'away');
    if (!hc || !ac) return null;
    const home = normTeam(hc), away = normTeam(ac);
    const { st, type, name, state } = statusOf(ev, comp);

    const notes = (comp.notes || ev.notes || []).map((n) => n && n.headline).filter(Boolean).join(' ');
    const seasonType = get(ev, 'season.type', null);
    const slug = String(get(ev, 'season.slug', ''));
    const isPostseason = seasonType === 3 || /post/i.test(slug);
    const isChampionship = isPostseason && CHAMP_RE.test(notes + ' ' + (ev.name || ''));

    const postponed = /POSTPONED|CANCEL|FORFEIT/i.test(name);
    return {
      id: String(ev.id),
      league,
      kind: 'team',
      state: postponed ? 'post' : state,
      completed: !!type.completed,
      postponed,
      delayed: /DELAY|SUSPEND/i.test(name),
      isHalftime: /HALFTIME/i.test(name),
      startTime: comp.date || ev.date || null,
      statusText: type.shortDetail || type.detail || type.description || '',
      statusDetail: type.detail || '',
      period: typeof st.period === 'number' ? st.period : parseInt(st.period, 10) || 0,
      clock: st.displayClock || '',
      clockSecs: typeof st.clock === 'number' ? st.clock : null,
      home, away,
      broadcasts: collectBroadcasts(comp, ev),
      odds: normOdds(comp, league, home, away),
      isPostseason, isChampionship,
      note: notes,
      neutral: !!comp.neutralSite,
      venue: get(comp, 'venue.fullName', ''),
    };
  }

  /* ---------- golf ---------- */
  function parseToPar(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    const s = String(v).trim().toUpperCase();
    if (s === 'E' || s === 'EVEN') return 0;
    const n = parseInt(s.replace('+', ''), 10);
    return isNaN(n) ? null : n;
  }

  function normGolfEvent(ev) {
    const comp = (ev.competitions && ev.competitions[0]) || null;
    if (!comp) return null;
    const { st, type, state } = statusOf(ev, comp);
    const detail = String(type.detail || type.description || '');
    const roundMatch = detail.match(/round\s*(\d)/i);
    const round = roundMatch ? parseInt(roundMatch[1], 10) : (typeof st.period === 'number' ? st.period : 1);
    const inProgress = state === 'in' && !/suspend|delay|weather|complete|final|official/i.test(detail);
    const players = (comp.competitors || []).map((c, i) => {
      const a = c.athlete || {};
      const ls = c.linescores || [];
      const lastLs = ls.length ? ls[ls.length - 1] : null;
      return {
        pos: c.order != null ? c.order : (c.sortOrder != null ? c.sortOrder : i + 1),
        name: a.displayName || a.shortName || get(c, 'team.displayName', ''),
        toPar: parseToPar(c.score != null && c.score !== '' ? c.score : get(c, 'statistics.0.displayValue', null)),
        scoreText: c.score != null ? String(c.score) : '',
        thru: get(c, 'status.thru', null) != null ? get(c, 'status.thru') : get(c, 'status.displayValue', ''),
        today: lastLs ? (lastLs.displayValue != null ? lastLs.displayValue : lastLs.value) : '',
      };
    }).sort((a, b) => a.pos - b.pos);
    return {
      id: String(ev.id),
      league: 'pga',
      kind: 'golf',
      name: ev.name || ev.shortName || 'PGA Tour event',
      state,
      completed: !!type.completed,
      startTime: ev.date || comp.date || null,
      endTime: ev.endDate || null,
      statusText: type.shortDetail || detail || '',
      statusDetail: detail,
      broadcasts: collectBroadcasts(comp, ev),
      golf: { round, inProgress, playoff: /playoff/i.test(detail), leaders: players },
      home: null, away: null,
    };
  }

  /* ---------- summary to win probability ---------- */
  function parseWinProb(json) {
    const arr = json && json.winprobability;
    if (!Array.isArray(arr) || !arr.length) return null;
    let vals = arr.map((x) => {
      let v = x && x.homeWinPercentage;
      if (v == null) return null;
      v = parseFloat(v);
      if (isNaN(v)) return null;
      return v > 1 ? v / 100 : v;
    }).filter((v) => v != null);
    if (!vals.length) return null;
    const home = vals[vals.length - 1];
    if (vals.length > 240) {
      const step = vals.length / 240;
      const ds = [];
      for (let i = 0; i < 240; i++) ds.push(vals[Math.floor(i * step)]);
      ds[239] = home;
      vals = ds;
    }
    return { home, history: vals };
  }

  return { SPORTS, scoreboardUrls, summaryUrl, normalizeScoreboard, parseWinProb, collectBroadcasts, normOdds, ymd };
});
