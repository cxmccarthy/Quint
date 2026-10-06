# Quint (Quintessential Sports)

A phone-friendly web app that ranks every live game and shows you the best one to watch right now.
No build step, no accounts, no API keys. It reads ESPN's public scoreboard feeds straight from your phone.

## Put it on your phone (free)

1. On GitHub, create a new **public** repository (free Pages hosting needs a public repo; the app contains no secrets).
2. Upload every file from this folder to the repository root. Keep them all at the top level, no folders.
3. In the repository, open Settings, then Pages. Under Build and deployment choose "Deploy from a branch", pick `main` and `/ (root)`, and save.
4. After a minute your app is at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.
5. iPhone: open that address in Safari, tap Share, then Add to Home Screen. Android: Chrome menu, then Install app.

Updating later: replace the changed files in the repository. The app picks them up the next time you open it.

## First run: check the feeds

Open the More tab and look at Data. Every feed should say OK with a game count and a size in kB.

- A feed says "Blocked or offline": your browser or network is refusing ESPN. Fill in the Proxy field with the address of a small relay you control, using `{url}` where the ESPN address goes.
- Something looks wrong in a sport (missing scores, wrong channels, no win probability): tap "Copy ESPN samples" and send me the text. ESPN's feeds are unofficial, and the parser was written without being able to test against live data.
- The Data section also lists the channel names ESPN used today. Green ones match your channels. Copy any missing name into Channels exactly as shown.

## How the points work

Every live game starts at 0. Rules add or subtract points, and the biggest game wins.

| Rule | Points |
| --- | --- |
| Your team is playing | +300 each |
| NBA game without the Celtics | -1000 |
| On a channel you have | +40 |
| Broadcast listed, none of your channels | -60 |
| Delayed or suspended | -50 |
| NFL / college football / NHL interest bump | +15 / +10 / +10 |
| Close game (leader's win probability under 80%) | up to +60, counting 35% at the start and 100% late |
| One score in the closing stretch (while still close) | +25 |
| Overtime or extra innings | +35, +8 for each extra period (up to +20) |
| Comeback in progress (a team gained 30+ points of win probability) | up to +30 |
| Upset brewing (pregame favorite trailing) | +15 to +30 |
| College football, both teams ranked | +30, +20 more if both top 10, +10 if one is top 10 |
| Playoffs / championship round | +40 / +20 more |
| Rivalry | +15 |

- **Blowouts are left out of Best** when the leader's win probability reaches 97%, or the margin is too big for how late it is. Games involving your teams are never filtered (switch this off in More).
- **Golf** scores the tournament as a whole: a crowded leaderboard, a tie for the lead, the final nine on Sunday, and playoffs add points. A runaway leader is marked down, then excluded.
- **Ties** go to the smaller margin, then the later point in the game.
- Upcoming and finished games always score 0. They are listed on each sport's tab.
- Win probability comes from ESPN for the top six games and is estimated from score and clock for the rest. The meter says which.

All values live in More, then Ranking, then Point values.

## Alerts

Alerts work only while Quint is open on your phone (a web page cannot run in the background on iPhone). On iPhone, add Quint to your Home Screen first, then turn alerts on from the Home Screen app. You get an alert when one of your teams goes live, and when a non-Boston game holds the top spot for 20 seconds with enough points.

## Files

`index.html`, `styles.css`, `app.js` (screen, refreshing, settings), `scoring.js` (the ranking rules), `espn.js` (reads ESPN's data), `sw.js` and `manifest.webmanifest` (Home Screen install), and the three icon files.
