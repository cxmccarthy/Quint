/* Quint (Quintessential Sports) scoring engine.
 * Pure functions, no DOM. Works in the browser (window.Scoring) and in node (for tests).
 *
 * Ranking order of importance:  your teams  >  can you watch it  >  drama.
 * Every rule adds or subtracts points; each game carries a list of reasons so the UI
 * can show why it ranked where it did. All numbers live in DEFAULT_WEIGHTS and can be
 * overridden from the Settings tab.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Scoring = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  function erf(x) {
    const s = Math.sign(x);
    x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

  /* ---------- league configuration ---------- */
  const LEAGUES = {
    nfl: { label: 'NFL', short: 'NFL', kind: 'clock', periods: 4, periodSecs: 900, sd: 13.5, oneScore: 8, lateLabel: 'One score, late', otLabel: 'Overtime' },
    cfb: { label: 'College football', short: 'CFB', kind: 'clock', periods: 4, periodSecs: 900, sd: 15.5, oneScore: 8, lateLabel: 'One score, late', otLabel: 'Overtime' },
    mlb: { label: 'MLB', short: 'MLB', kind: 'innings', sd: 4.3, oneScore: 2, lateLabel: 'Tight late innings', otLabel: 'Extra innings' },
    nhl: { label: 'NHL', short: 'NHL', kind: 'clock', periods: 3, periodSecs: 1200, sd: 2.45, oneScore: 1, lateLabel: 'One goal, late', otLabel: 'Overtime' },
    nba: { label: 'NBA', short: 'NBA', kind: 'clock', periods: 4, periodSecs: 720, sd: 12, oneScore: 5, lateLabel: 'One possession, late', otLabel: 'Overtime' },
    pga: { label: 'PGA Tour', short: 'PGA', kind: 'golf' },
  };

  /* ---------- defaults ---------- */
  const DEFAULT_WEIGHTS = {
    favorite: 300,          // per favorite team in the game; big enough that your teams always outrank everything else
    nbaNoFavorite: -1000,   // NBA game with no favorite team
    available: 40,
    unavailable: -60,
    delayed: -50,
    sport: { nfl: 15, cfb: 10, nhl: 10, mlb: 0, nba: 0, pga: 0 },
    closeMax: 60,           // max points for pure closeness (win probability near 50/50)
    closeEarlyFactor: 0.35, // closeness counts 35% at kickoff, 100% at the end
    oneScoreLate: 25,
    overtime: 35,
    overtimeExtra: 8,
    overtimeExtraCap: 20,
    comebackMax: 30,
    upsetBase: 15,
    upsetMax: 30,
    rankedBoth: 30,
    rankedBothTop10: 20,
    rankedOneTop10: 10,
    postseason: 40,
    championship: 20,
    rivalry: 15,
    golf: { crowd: 5, tiedLead: 25, finalNine: 20, playoff: 60, runaway: -30 },
  };

  const DEFAULT_SETTINGS = {
    favorites: ['nfl:NE', 'nba:BOS', 'nhl:BOS', 'mlb:BOS'],
    channels: ['NESN', 'NESN+', 'CBS', 'FOX', 'NBC', 'ESPN', 'ESPN2', 'ABC'],
    leagues: ['nfl', 'cfb', 'mlb', 'nhl', 'nba', 'pga'],
    wpClose: 0.80,          // a game only counts as "close" when the leader's win probability is under this
    wpBlowout: 0.97,        // at or above this the game is treated as garbage time and excluded from Best
    favoritesExemptFromExclusion: true,
    minBestScore: -200,
    weights: DEFAULT_WEIGHTS,
  };

  /* ---------- rivalries (match on shortName for pro leagues, location for college) ---------- */
  const RIV = {
    nfl: ['cowboys|eagles', 'cowboys|commanders', 'giants|eagles', 'packers|bears', 'packers|vikings', 'bears|vikings', 'steelers|ravens', 'steelers|browns', 'ravens|browns', 'bengals|browns', 'bengals|steelers', 'chiefs|raiders', 'chiefs|broncos', 'chargers|raiders', 'broncos|raiders', '49ers|seahawks', '49ers|rams', 'rams|seahawks', '49ers|cowboys', 'patriots|jets', 'patriots|bills', 'patriots|dolphins', 'bills|dolphins', 'bills|jets', 'jets|giants', 'saints|falcons', 'buccaneers|saints', 'panthers|falcons', 'titans|colts', 'texans|colts', 'jaguars|titans', 'lions|packers', 'lions|bears', 'chiefs|bills', 'chiefs|ravens', 'eagles|commanders'],
    cfb: ['michigan|ohio state', 'alabama|auburn', 'texas|oklahoma', 'georgia|florida', 'usc|ucla', 'usc|notre dame', 'notre dame|michigan', 'army|navy', 'oregon|washington', 'clemson|south carolina', 'florida state|florida', 'miami|florida state', 'lsu|alabama', 'texas a&m|texas', 'tennessee|alabama', 'penn state|ohio state', 'michigan|michigan state', 'georgia|georgia tech', 'ole miss|mississippi state', 'lsu|arkansas', 'iowa|iowa state', 'wisconsin|minnesota', 'boston college|notre dame', 'georgia|auburn', 'tennessee|florida', 'oklahoma|oklahoma state'],
    nhl: ['bruins|canadiens', 'canadiens|maple leafs', 'rangers|islanders', 'rangers|devils', 'rangers|flyers', 'penguins|flyers', 'penguins|capitals', 'blackhawks|blues', 'blackhawks|red wings', 'oilers|flames', 'kings|sharks', 'kings|ducks', 'red wings|maple leafs', 'bruins|maple leafs', 'bruins|rangers'],
    mlb: ['yankees|red sox', 'yankees|mets', 'dodgers|giants', 'cubs|cardinals', 'dodgers|padres', 'mets|phillies', 'braves|mets', 'astros|rangers', 'white sox|cubs', 'dodgers|angels', 'yankees|orioles', 'blue jays|yankees', 'royals|cardinals', 'orioles|red sox', 'blue jays|red sox'],
    nba: [],
  };
  function pairKey(a, b) { return [String(a || '').toLowerCase(), String(b || '').toLowerCase()].sort().join('|'); }
  function isRivalry(g) {
    const list = RIV[g.league];
    if (!list || !list.length || !g.home || !g.away) return false;
    const key = g.league === 'cfb' ? pairKey(g.home.location, g.away.location) : pairKey(g.home.shortName, g.away.shortName);
    return list.some((r) => r.split('|').sort().join('|') === key);
  }

  /* ---------- helpers ---------- */
  function isFavorite(team, league, favs) {
    if (!team) return false;
    const a = String(team.abbr || '').toLowerCase();
    const n = String(team.name || '').toLowerCase();
    const s = String(team.shortName || '').toLowerCase();
    return (favs || []).some((f) => {
      const parts = String(f).toLowerCase().split(':');
      if (parts.length < 2) return false;
      return parts[0] === league && (parts[1] === a || parts[1] === n || parts[1] === s);
    });
  }

  function normChannel(n) { return String(n || '').toLowerCase().replace(/[^a-z0-9+]/g, ''); }
  function channelSet(list) { return new Set((list || []).map(normChannel)); }
  /* true = on a channel you have, false = broadcast listed but none of yours, null = no broadcast info */
  function channelsAvailable(g, set) {
    if (!g.broadcasts || !g.broadcasts.length) return null;
    return g.broadcasts.some((b) => set.has(normChannel(b)));
  }

  function parseClock(s) {
    if (s == null || s === '') return null;
    const m = String(s).match(/^(\d+):(\d+(?:\.\d+)?)$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  /* progress through the game (0..1) plus overtime info */
  function progressOf(g) {
    const L = LEAGUES[g.league];
    if (L.kind === 'clock') {
      const p = g.period || 1;
      const dur = L.periodSecs;
      if (g.isHalftime) return { progress: 0.5, overtime: false, otCount: 0 };
      if (p > L.periods) return { progress: 1, overtime: true, otCount: p - L.periods };
      let rem = typeof g.clockSecs === 'number' && isFinite(g.clockSecs) ? g.clockSecs : parseClock(g.clock);
      if (rem == null) rem = dur;
      rem = clamp(rem, 0, dur);
      return { progress: clamp(((p - 1) * dur + (dur - rem)) / (L.periods * dur), 0, 1), overtime: false, otCount: 0 };
    }
    if (L.kind === 'innings') {
      const inning = g.period || 1;
      const t = String(g.statusText || '').toLowerCase();
      let off = 0.5;
      if (/^top|\btop\b/.test(t)) off = 0.25;
      else if (/^mid|\bmid\b/.test(t)) off = 0.5;
      else if (/^bot|\bbot\b|bottom/.test(t)) off = 0.75;
      else if (/^end|\bend\b/.test(t)) off = 1;
      if (inning > 9) return { progress: 1, overtime: true, otCount: inning - 9 };
      return { progress: clamp(((inning - 1) + off) / 9, 0, 1), overtime: false, otCount: 0 };
    }
    return { progress: 0, overtime: false, otCount: 0 };
  }

  /* fallback win probability (home) when ESPN doesn't provide one: normal approximation on the score margin */
  function estimateHomeWP(g, prog) {
    const L = LEAGUES[g.league];
    const margin = (g.home.score || 0) - (g.away.score || 0);
    if (margin === 0) return 0.5;
    const frac = prog.overtime ? 0.06 : Math.max(0.015, 1 - prog.progress);
    return normCdf(margin / (L.sd * Math.sqrt(frac)));
  }

  function hardBlowout(lg, p, m) {
    switch (lg) {
      case 'nfl': case 'cfb': return (p >= 0.5 && m >= 24) || (p >= 0.75 && m >= 17) || (p >= 0.9 && m >= 14);
      case 'nhl': return (p >= 0.67 && m >= 4) || (p >= 0.9 && m >= 3);
      case 'mlb': return (p >= 0.55 && m >= 8) || (p >= 0.7 && m >= 6) || (p >= 0.85 && m >= 5);
      case 'nba': return (p >= 0.5 && m >= 25) || (p >= 0.75 && m >= 18);
      default: return false;
    }
  }

  function mergeSettings(saved) {
    const s = Object.assign({}, DEFAULT_SETTINGS, saved || {});
    const w = Object.assign({}, DEFAULT_WEIGHTS, (saved && saved.weights) || {});
    w.sport = Object.assign({}, DEFAULT_WEIGHTS.sport, ((saved && saved.weights) || {}).sport || {});
    w.golf = Object.assign({}, DEFAULT_WEIGHTS.golf, ((saved && saved.weights) || {}).golf || {});
    s.weights = w;
    return s;
  }

  function newOut() {
    return { score: 0, excluded: false, excludeReason: null, inactive: false, reasons: [], wp: null, leaderWP: null, margin: null, progress: null, available: null };
  }

  /* ---------- team sports ---------- */
  function scoreTeamGame(g, ctx) {
    const s = ctx.settings;
    const W = s.weights;
    const L = LEAGUES[g.league];
    const out = newOut();
    let score = 0;
    const add = (label, pts, kind) => {
      if (!pts) return;
      score += pts;
      out.reasons.push({ label, pts: Math.round(pts), kind: kind || 'drama' });
    };

    if (g.state !== 'in') { out.inactive = true; return out; }

    const favHome = isFavorite(g.home, g.league, s.favorites);
    const favAway = isFavorite(g.away, g.league, s.favorites);
    const favCount = (favHome ? 1 : 0) + (favAway ? 1 : 0);
    const prog = progressOf(g);
    out.progress = prog.progress;
    const margin = Math.abs((g.home.score || 0) - (g.away.score || 0));
    out.margin = margin;

    const espnWP = ctx.wp && typeof ctx.wp.home === 'number' ? ctx.wp.home : null;
    const homeWP = espnWP != null ? espnWP : estimateHomeWP(g, prog);
    const leaderWP = Math.max(homeWP, 1 - homeWP);
    out.wp = { home: homeWP, source: espnWP != null ? (ctx.wp.source || 'espn') : 'est' };
    out.leaderWP = leaderWP;

    /* 1. your teams */
    if (favCount) {
      const names = [favHome ? g.home.shortName : null, favAway ? g.away.shortName : null].filter(Boolean).join(' and ');
      add(names, W.favorite * favCount, 'fav');
    } else if (g.league === 'nba') {
      add('NBA without the Celtics', W.nbaNoFavorite, 'penalty');
    }

    /* 2. can you watch it */
    const avail = channelsAvailable(g, ctx.channelSet || new Set());
    out.available = avail;
    if (avail === true) add('On your channels', W.available, 'avail');
    else if (avail === false) add('Not on your channels', W.unavailable, 'avail');
    if (g.delayed) add('Delayed', W.delayed, 'penalty');

    const sportPts = (W.sport || {})[g.league] || 0;
    if (sportPts) add(L.short + ' bump', sportPts, 'sport');

    /* garbage time */
    const exempt = favCount > 0 && s.favoritesExemptFromExclusion;
    if (!prog.overtime && (leaderWP >= s.wpBlowout || hardBlowout(g.league, prog.progress, margin)) && !exempt) {
      out.excluded = true;
      out.excludeReason = 'Blowout';
    }

    /* 3. drama, gated by the win-probability filter */
    const isClose = leaderWP < s.wpClose;
    if (isClose) {
      const unc = clamp((s.wpClose - leaderWP) / (s.wpClose - 0.5), 0, 1);
      const late = W.closeEarlyFactor + (1 - W.closeEarlyFactor) * Math.pow(prog.progress, 2);
      add(prog.progress >= 0.75 ? 'Late and close' : 'Close game', W.closeMax * unc * late);
      if (prog.progress >= 0.75 && margin <= L.oneScore) add(L.lateLabel, W.oneScoreLate);
    }
    if (prog.overtime) {
      add(L.otLabel, W.overtime + Math.min(W.overtimeExtraCap, W.overtimeExtra * Math.max(0, prog.otCount - 1)));
    }

    /* comeback in progress: someone climbed back 30+ points of win probability */
    const hist = ctx.wp && ctx.wp.history && ctx.wp.history.length > 5 ? ctx.wp.history : null;
    if (hist && leaderWP < 0.90) {
      const minHome = Math.min.apply(null, hist);
      const maxHome = Math.max.apply(null, hist);
      const swingHome = homeWP - minHome;
      const swingAway = maxHome - homeWP;
      const swing = Math.max(swingHome, swingAway);
      const cur = swingHome >= swingAway ? homeWP : 1 - homeWP;
      if (swing >= 0.30 && cur >= 0.35) add('Comeback in progress', 5 + (W.comebackMax - 5) * clamp((swing - 0.30) / 0.35, 0, 1));
    }

    /* upset brewing: pregame favorite is losing, or the underdog is close behind */
    if (g.odds && g.odds.favoriteSide && g.odds.favProb != null && g.odds.favProb >= 0.62 && leaderWP < 0.90) {
      const favWP = g.odds.favoriteSide === 'home' ? homeWP : 1 - homeWP;
      const dogWP = 1 - favWP;
      const str = clamp((g.odds.favProb - 0.55) / 0.30, 0, 1);
      const pts = W.upsetBase + (W.upsetMax - W.upsetBase) * str;
      if (dogWP >= 0.5) add('Upset brewing', pts);
      else if (dogWP >= 0.30 && g.odds.favProb >= 0.72 && prog.progress >= 0.4) add('Underdog hanging around', pts * 0.5);
    }

    /* college football: ranked matchups */
    if (g.league === 'cfb') {
      const rh = g.home.rank, ra = g.away.rank;
      if (rh && ra) {
        add('Ranked vs ranked', W.rankedBoth);
        if (rh <= 10 && ra <= 10) add('Top-10 matchup', W.rankedBothTop10);
      } else if ((rh && rh <= 10) || (ra && ra <= 10)) {
        add('Top-10 team', W.rankedOneTop10);
      }
    }

    if (g.isPostseason) {
      add('Playoffs', W.postseason);
      if (g.isChampionship) add('Championship round', W.championship);
    }
    if (isRivalry(g)) add('Rivalry', W.rivalry);

    out.score = Math.round(score);
    return out;
  }

  /* ---------- golf (one tournament, not a head-to-head) ---------- */
  function scoreGolfEvent(g, ctx) {
    const s = ctx.settings;
    const W = s.weights;
    const G = W.golf;
    const out = newOut();
    let score = 0;
    const add = (label, pts, kind) => {
      if (!pts) return;
      score += pts;
      out.reasons.push({ label, pts: Math.round(pts), kind: kind || 'drama' });
    };
    const gf = g.golf || {};
    if (g.state !== 'in' || !gf.inProgress) { out.inactive = true; return out; }

    const avail = channelsAvailable(g, ctx.channelSet || new Set());
    out.available = avail;
    if (avail === true) add('On your channels', W.available, 'avail');
    else if (avail === false) add('Not on your channels', W.unavailable, 'avail');
    const sportPts = (W.sport || {}).pga || 0;
    if (sportPts) add('PGA bump', sportPts, 'sport');

    const round = clamp(gf.round || 1, 1, 5);
    const roundW = [0, 0.35, 0.5, 0.8, 1, 1][round];
    const leaders = (gf.leaders || []).filter((p) => typeof p.toPar === 'number').sort((a, b) => a.toPar - b.toPar);
    out.progress = (round - 1 + 0.5) / 4;
    if (leaders.length) {
      const lead = leaders[0].toPar;
      const within2 = leaders.filter((p) => p.toPar - lead <= 2).length;
      const gap = leaders[1] ? leaders[1].toPar - lead : null;
      out.margin = gap;
      if (within2 >= 3) add('Crowded leaderboard', Math.min(within2, 8) * G.crowd * roundW);
      if (gap === 0) add('Tied for the lead', G.tiedLead * roundW);
      const thru = parseInt(leaders[0].thru, 10);
      if (round >= 4 && !isNaN(thru) && thru >= 10) add('Final nine', G.finalNine);
      if (round >= 3 && gap != null && gap >= 5) add('Leader running away', G.runaway);
      if (round >= 4 && gap != null && gap >= 7 && !isNaN(thru) && thru >= 12) {
        out.excluded = true;
        out.excludeReason = 'Runaway';
      }
    }
    if (gf.playoff) add('Playoff', G.playoff);
    out.score = Math.round(score);
    return out;
  }

  function scoreGame(g, ctx) {
    return g.league === 'pga' ? scoreGolfEvent(g, ctx) : scoreTeamGame(g, ctx);
  }

  /* ---------- ranking ---------- */
  function cmp(a, b) {
    return (b.s.score - a.s.score)
      || ((a.s.margin == null ? 99 : a.s.margin) - (b.s.margin == null ? 99 : b.s.margin))
      || ((b.s.progress || 0) - (a.s.progress || 0));
  }
  function rankLive(entries, settings) {
    const min = settings && typeof settings.minBestScore === 'number' ? settings.minBestScore : -200;
    return entries.filter((e) => !e.s.inactive && !e.s.excluded && e.s.score >= min).sort(cmp);
  }

  return {
    LEAGUES, DEFAULT_SETTINGS, DEFAULT_WEIGHTS,
    mergeSettings, scoreGame, rankLive, cmp,
    channelSet, channelsAvailable, normChannel, isFavorite, isRivalry,
    progressOf, estimateHomeWP, normCdf, parseClock,
  };
});
