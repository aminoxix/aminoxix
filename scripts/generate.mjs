// Renders the profile README's SVG stat cards.
//
//   GH_TOKEN=<token> node scripts/generate.mjs   fetch live data, refresh data/stats.json, render
//   node scripts/generate.mjs                    re-render the last snapshot, no network
//
// Everything here ends up in a public repository, so private activity is only ever
// counted, never named or itemised.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const LOGIN = process.env.GH_LOGIN || 'aminoxix';
const TOKEN = process.env.GH_TOKEN;
const OUT = new URL('../assets/', import.meta.url);
const SNAPSHOT = new URL('../data/stats.json', import.meta.url);

// Owners whose merged PRs are folded into one row; anything unlisted becomes "Other".
const GROUPS = {
  'Layer5 · Meshery': ['layer5io', 'meshery', 'meshery-extensions', 'service-mesh-performance', 'service-mesh-patterns'],
  BUGTRONS: ['bugtrons'],
  DEVSTRONS: ['devstrons'],
  AsyncAPI: ['asyncapi'],
  TheAlgorithms: ['thealgorithms'],
  Devicon: ['devicons'],
  'CNCF · Jenkins X': ['cncf', 'jenkins-x', 'chaoss'],
};

async function gql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
  return json.data;
}

const COLLECTION = `contributionsCollection(from: $from, to: $to) {
  restrictedContributionsCount
  totalCommitContributions totalIssueContributions
  totalPullRequestContributions totalPullRequestReviewContributions
  contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
}`;

async function collect(from, to) {
  const d = await gql(
    `query($login: String!, $from: DateTime!, $to: DateTime!) { user(login: $login) { ${COLLECTION} } }`,
    { login: LOGIN, from: from.toISOString(), to: to.toISOString() },
  );
  return d.user.contributionsCollection;
}

async function fetchLive() {
  const now = new Date();
  const yearAgo = new Date(now);
  yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);

  const { user } = await gql(`query($login: String!) { user(login: $login) { createdAt } }`, { login: LOGIN });
  const last = await collect(yearAgo, now);

  const weeks = last.contributionCalendar.weeks.map((w) => w.contributionDays.map((d) => d.contributionCount));
  const days = weeks.flat();
  let run = 0;
  let longestStreak = 0;
  for (const c of days) {
    run = c > 0 ? run + 1 : 0;
    longestStreak = Math.max(longestStreak, run);
  }

  const yearly = {};
  for (let y = new Date(user.createdAt).getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    const end = new Date(Math.min(Date.UTC(y, 11, 31, 23, 59, 59), now.getTime()));
    const c = await collect(new Date(Date.UTC(y, 0, 1)), end);
    yearly[y] = c.contributionCalendar.totalContributions;
  }

  // Public repos only: the qualifier filters the search and the per-node check guards against
  // it ever returning private results, since the output is committed to a public repository.
  const repos = new Set();
  const byOwner = {};
  let mergedPRs = 0;
  let after = null;
  do {
    const d = await gql(
      `query($q: String!, $after: String) {
         search(query: $q, type: ISSUE, first: 100, after: $after) {
           pageInfo { hasNextPage endCursor }
           nodes { ... on PullRequest { repository { nameWithOwner isPrivate owner { login } } } }
         }
       }`,
      { q: `author:${LOGIN} is:pr is:merged is:public -user:${LOGIN}`, after },
    );
    for (const n of d.search.nodes) {
      if (!n.repository || n.repository.isPrivate) continue;
      mergedPRs++;
      repos.add(n.repository.nameWithOwner);
      byOwner[n.repository.owner.login] = (byOwner[n.repository.owner.login] ?? 0) + 1;
    }
    after = d.search.pageInfo.hasNextPage ? d.search.pageInfo.endCursor : null;
  } while (after);

  return {
    generatedAt: now.toISOString().slice(0, 10),
    contributions12m: last.contributionCalendar.totalContributions,
    activeDays: days.filter((c) => c > 0).length,
    longestStreak,
    weekly: weeks.slice(-52).map((w) => w.reduce((a, b) => a + b, 0)),
    yearly,
    mergedPRs,
    externalRepos: repos.size,
    byOwner: Object.entries(byOwner).sort((a, b) => b[1] - a[1]),
    focus: {
      commits: last.totalCommitContributions,
      pullRequests: last.totalPullRequestContributions,
      reviews: last.totalPullRequestReviewContributions,
      issues: last.totalIssueContributions,
      private: last.restrictedContributionsCount,
    },
  };
}

const C = {
  bg1: '#0a1628',
  bg2: '#0d2242',
  border: '#1d4270',
  tile: '#0c2140',
  grid: '#17335c',
  accent: '#58a6ff',
  mid: '#2f81f7',
  deep: '#1f6feb',
  pale: '#a5d6ff',
  slate: '#4b6b9e',
  text: '#e6f0ff',
  muted: '#8fa8c8',
};
const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => Number(n).toLocaleString('en-US');
const f1 = (n) => n.toFixed(1);
const pct = (x) => (x > 0 && x < 0.005 ? '<1%' : `${Math.round(x * 100)}%`);

const text = (x, y, s, { size = 12, fill = C.muted, weight = 400, anchor = 'start' } = {}) =>
  `<text x="${f1(x)}" y="${f1(y)}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`;

const frame = (w, h, title, inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}" font-family="${FONT}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg2}"/></linearGradient>
  <linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.accent}" stop-opacity=".5"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></linearGradient>
  <linearGradient id="barh" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.deep}"/><stop offset="1" stop-color="${C.accent}"/></linearGradient>
  <linearGradient id="barv" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${C.deep}"/><stop offset="1" stop-color="${C.accent}"/></linearGradient>
</defs>
<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="12" fill="url(#bg)" stroke="${C.border}"/>
${inner}
</svg>
`;

// Catmull-Rom -> cubic bezier, control points clamped so peaks never overshoot the plot.
function smoothPath(p, yMin, yMax) {
  const clamp = (y) => Math.min(yMax, Math.max(yMin, y));
  let d = `M${f1(p[0][0])},${f1(p[0][1])}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, clamp(p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, clamp(p2[1] - (p3[1] - p1[1]) / 6)];
    d += ` C${f1(c1[0])},${f1(c1[1])} ${f1(c2[0])},${f1(c2[1])} ${f1(p2[0])},${f1(p2[1])}`;
  }
  return d;
}

function overview(d) {
  const tiles = [
    [fmt(d.contributions12m), 'contributions', 'last 12 months, private included'],
    [fmt(d.mergedPRs), 'merged PRs', `across ${d.externalRepos} repos I don't own`],
    [fmt(d.activeDays), 'active days', 'out of the last 365'],
    [fmt(d.longestStreak), 'day streak', 'longest run in 12 months'],
  ];
  const w = 830;
  const pad = 14;
  const gap = 12;
  const tw = (w - pad * 2 - gap * 3) / 4;
  const inner = tiles
    .map(([v, label, sub], i) => {
      const x = pad + i * (tw + gap);
      return [
        `<rect x="${f1(x)}" y="14" width="${f1(tw)}" height="84" rx="8" fill="${C.tile}"/>`,
        text(x + 16, 52, v, { size: 30, fill: C.accent, weight: 700 }),
        text(x + 16, 72, label, { size: 13, fill: C.text, weight: 600 }),
        text(x + 16, 88, sub, { size: 10.5 }),
      ].join('\n');
    })
    .join('\n');
  return frame(w, 112, 'Contribution overview', inner);
}

function activity(d) {
  const w = 830;
  const h = 262;
  const x0 = 46;
  const y0 = 66;
  const cw = 462;
  const ch = 136;
  const wk = d.weekly;
  const max = Math.max(...wk, 1);
  const pts = wk.map((v, i) => [x0 + (i * cw) / (wk.length - 1), y0 + ch - (v / max) * ch]);
  const line = smoothPath(pts, y0, y0 + ch);
  const area = `${line} L${f1(x0 + cw)},${y0 + ch} L${x0},${y0 + ch} Z`;

  const grid = [0, 0.5, 1]
    .map((f) => {
      const y = y0 + ch - f * ch;
      return `<line x1="${x0}" x2="${x0 + cw}" y1="${f1(y)}" y2="${f1(y)}" stroke="${C.grid}" stroke-dasharray="3 4"/>` +
        text(x0 - 8, y + 4, Math.round(max * f), { size: 10.5, anchor: 'end' });
    })
    .join('\n');

  const peak = wk.indexOf(max);
  const [px, py] = pts[peak];
  const peakLabel = `<circle cx="${f1(px)}" cy="${f1(py)}" r="4" fill="${C.pale}" stroke="${C.bg1}" stroke-width="2"/>` +
    text(px - 10, py - 4, `peak week · ${max}`, { size: 10.5, fill: C.pale, anchor: 'end' });

  const years = Object.entries(d.yearly).sort().slice(-6);
  const bx = 566;
  const bw = 240;
  const gapB = 12;
  const barW = (bw - gapB * (years.length - 1)) / years.length;
  const yMax = Math.max(...years.map(([, v]) => v), 1);
  const base = y0 + ch;
  const currentYear = String(new Date(d.generatedAt).getUTCFullYear());
  const bars = years
    .map(([y, v], i) => {
      const bh = Math.max(3, (v / yMax) * (ch - 18));
      const x = bx + i * (barW + gapB);
      const cur = y === currentYear;
      return [
        `<rect x="${f1(x)}" y="${f1(base - bh)}" width="${f1(barW)}" height="${f1(bh)}" rx="3" fill="${cur ? 'url(#barv)' : C.deep}" fill-opacity="${cur ? 1 : 0.55}"/>`,
        text(x + barW / 2, base - bh - 6, fmt(v), { size: 10.5, fill: cur ? C.accent : C.text, weight: cur ? 700 : 400, anchor: 'middle' }),
        text(x + barW / 2, base + 18, cur ? `${y}*` : y, { size: 11, anchor: 'middle' }),
      ].join('\n');
    })
    .join('\n');

  const inner = [
    text(24, 34, 'Contribution activity', { size: 15, fill: C.text, weight: 700 }),
    text(24, 52, 'weekly, last 12 months', { size: 11 }),
    grid,
    `<path d="${area}" fill="url(#area)"/>`,
    `<path d="${line}" fill="none" stroke="${C.accent}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`,
    peakLabel,
    text(x0, y0 + ch + 20, '12 months ago', { size: 10.5 }),
    text(x0 + cw, y0 + ch + 20, 'now', { size: 10.5, anchor: 'end' }),
    `<line x1="538" x2="538" y1="24" y2="${h - 24}" stroke="${C.grid}"/>`,
    text(bx, 34, 'By year', { size: 15, fill: C.text, weight: 700 }),
    text(bx, 52, 'all contributions, public and private', { size: 11 }),
    bars,
    text(bx + bw, h - 16, `* year to date · updated ${d.generatedAt}`, { size: 10, anchor: 'end' }),
  ].join('\n');
  return frame(w, h, 'Contribution activity by week and by year', inner);
}

function oss(d) {
  const w = 830;
  const h = 268;

  const lookup = new Map();
  for (const [label, owners] of Object.entries(GROUPS)) for (const o of owners) lookup.set(o.toLowerCase(), label);
  const rows = {};
  for (const [owner, n] of d.byOwner) {
    const label = lookup.get(owner.toLowerCase()) ?? 'Other';
    rows[label] = (rows[label] ?? 0) + n;
  }
  const list = Object.entries(rows)
    .filter(([k]) => k !== 'Other')
    .sort((a, b) => b[1] - a[1]);
  if (rows.Other) list.push(['Other', rows.Other]);

  const lx = 24;
  const barX = 150;
  const barMax = 300;
  const top = Math.max(...list.map(([, n]) => n), 1);
  const bars = list
    .map(([label, n], i) => {
      const y = 66 + i * 24;
      const bw = Math.max(4, (n / top) * barMax);
      return [
        text(lx, y + 12, label, { size: 12, fill: C.text }),
        `<rect x="${barX}" y="${y}" width="${barMax}" height="14" rx="7" fill="${C.tile}"/>`,
        `<rect x="${barX}" y="${y}" width="${f1(bw)}" height="14" rx="7" fill="url(#barh)"/>`,
        text(barX + barMax + 12, y + 12, n, { size: 12, fill: C.accent, weight: 700 }),
      ].join('\n');
    })
    .join('\n');

  const f = d.focus;
  const parts = [
    ['Commits', f.commits, C.accent],
    ['Pull requests', f.pullRequests, C.mid],
    ['Code review', f.reviews, C.deep],
    ['Issues', f.issues, C.pale],
    ['Private repos', f.private ?? 0, C.slate],
  ].filter(([, v]) => v > 0);
  const sum = parts.reduce((a, [, v]) => a + v, 0) || 1;
  const cx = 616;
  const cy = 148;
  const r = 44;
  const circ = 2 * Math.PI * r;
  let acc = 0;
  const arcs = parts
    .map(([, v, col]) => {
      const len = (v / sum) * circ;
      const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col}" stroke-width="16" stroke-dasharray="${f1(Math.max(0, len - 2))} ${f1(circ)}" stroke-dashoffset="${f1(-acc)}" transform="rotate(-90 ${cx} ${cy})"/>`;
      acc += len;
      return seg;
    })
    .join('\n');
  const legend = parts
    .map(([label, v, col], i) => {
      const y = 118 + i * 24;
      return `<circle cx="694" cy="${y - 4}" r="4.5" fill="${col}"/>` +
        text(706, y, label, { size: 12, fill: C.text }) +
        text(806, y, pct(v / sum), { size: 12, fill: C.accent, weight: 700, anchor: 'end' });
    })
    .join('\n');

  const inner = [
    text(24, 34, 'Open source & community', { size: 15, fill: C.text, weight: 700 }),
    text(24, 52, `${fmt(d.mergedPRs)} merged PRs in ${d.externalRepos} repos I don't own`, { size: 11 }),
    bars,
    `<line x1="518" x2="518" y1="24" y2="${h - 24}" stroke="${C.grid}"/>`,
    text(544, 34, 'Where the work goes', { size: 15, fill: C.text, weight: 700 }),
    text(544, 52, 'public activity vs private, last 12 months', { size: 11 }),
    arcs,
    text(cx, cy + 3, fmt(sum), { size: 15, fill: C.text, weight: 700, anchor: 'middle' }),
    text(cx, cy + 17, 'total', { size: 10, anchor: 'middle' }),
    legend,
  ].join('\n');
  return frame(w, h, 'Open source contributions and contribution mix', inner);
}

// data/stats.json is written only by fetchLive(); without a token the last snapshot is reused.
async function load() {
  if (TOKEN) return fetchLive();
  try {
    return JSON.parse(await readFile(SNAPSHOT, 'utf8'));
  } catch (err) {
    throw new Error(`No GH_TOKEN and data/stats.json is unreadable (${err.message}). Set GH_TOKEN to generate it.`);
  }
}

// Never replace good cards with empty ones (bad token, API hiccup, wrong login).
function assertSane(d) {
  if (!(d.contributions12m > 0) || d.weekly.length < 2 || !Object.keys(d.yearly).length) {
    throw new Error(`Refusing to render: data looks empty (${JSON.stringify({ c: d.contributions12m, w: d.weekly.length })})`);
  }
}

const data = await load();
assertSane(data);

// Render before writing so a failure cannot leave a half-updated set of files.
const files = {
  'overview.svg': overview(data),
  'activity.svg': activity(data),
  'oss.svg': oss(data),
};

await mkdir(OUT, { recursive: true });
await Promise.all(Object.entries(files).map(([name, svg]) => writeFile(new URL(name, OUT), svg)));
if (TOKEN) await writeFile(SNAPSHOT, JSON.stringify(data, null, 2) + '\n');
console.log(`rendered from ${TOKEN ? 'live GraphQL data' : 'data/stats.json'} (${data.generatedAt})`);
