const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Schema ───────────────────────────────────────────────────────────────
// Idempotent on boot. `reports` is marked `staging:private`: it holds who
// reported whom, so staging copies its schema but never its rows, and no
// public table carries a foreign key to it.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decisions (
      id text PRIMARY KEY,
      author_id text NOT NULL,
      author_name text NOT NULL,
      question text NOT NULL,
      created_at timestamptz NOT NULL,
      closed_at timestamptz,
      is_demo boolean NOT NULL DEFAULT false,
      demo_key text UNIQUE
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS choices (
      id text PRIMARY KEY,
      decision_id text NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      label text NOT NULL,
      position integer NOT NULL
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS votes (
      decision_id text NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      choice_id text NOT NULL REFERENCES choices(id) ON DELETE CASCADE,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (decision_id, user_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id text PRIMARY KEY,
      decision_id text NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      author_id text NOT NULL,
      author_name text NOT NULL,
      body text NOT NULL,
      created_at timestamptz NOT NULL
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      reporter_id text NOT NULL,
      target_type text NOT NULL CHECK (target_type IN ('decision', 'comment')),
      target_id text NOT NULL,
      created_at timestamptz NOT NULL
    )`);
  await pool.query(`COMMENT ON TABLE reports IS 'staging:private'`);
}

// ── Demo (staging only) ──────────────────────────────────────────────────
// The first version's populated preview: four questions asked by made-up
// people, seeded at boot, plus (on the viewer's first ?demo=1 request) one
// question of their own so the screen shows their seat too. Fixed ids and
// ON CONFLICT DO NOTHING everywhere, so a reload changes nothing and what
// the viewer does to these rows afterwards stays. The plain route never
// shows is_demo rows.
const DEMO_PEOPLE = {
  ada: ['demo-ada', 'Demo Ada'],
  bram: ['demo-bram', 'Demo Bram'],
  priya: ['demo-priya', 'Demo Priya'],
  marcus: ['demo-marcus', 'Demo Marcus'],
};

async function seedDemo() {
  const c = (sql, params) => pool.query(sql, params);
  const vote = (decision, user, choice) =>
    c(`INSERT INTO votes (decision_id, user_id, choice_id, updated_at)
       VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING`, [decision, user, choice]);
  const comment = (id, decision, who, body, at) =>
    c(`INSERT INTO comments (id, decision_id, author_id, author_name, body, created_at)
       VALUES ($1, $2, $3, $4, $5, now() - $6::interval) ON CONFLICT (id) DO NOTHING`,
      [id, decision, DEMO_PEOPLE[who][0], DEMO_PEOPLE[who][1], body, at]);

  // June outing — Demo Priya, open, viewer has not voted on it.
  await c(`INSERT INTO decisions (id, author_id, author_name, question, created_at, is_demo, demo_key)
           VALUES ('demo-outing', $1, $2, 'What should our June outing be?', now() - interval '5 hours', true, 'demo-outing')
           ON CONFLICT DO NOTHING`, [...DEMO_PEOPLE.priya]);
  await c(`INSERT INTO choices (id, decision_id, label, position) VALUES
           ('demo-outing-a', 'demo-outing', 'Botanical garden walk', 0),
           ('demo-outing-b', 'demo-outing', 'Pottery evening', 1),
           ('demo-outing-c', 'demo-outing', 'Trivia night at the community hall', 2)
           ON CONFLICT DO NOTHING`);
  for (const [user, choice] of [
    ['demo-voter-1', 'demo-outing-a'], ['demo-voter-2', 'demo-outing-a'],
    ['demo-voter-3', 'demo-outing-a'], ['demo-voter-4', 'demo-outing-a'],
    ['demo-voter-5', 'demo-outing-b'], ['demo-voter-6', 'demo-outing-c'],
  ]) await vote('demo-outing', user, choice);
  await comment('demo-outing-c1', 'demo-outing', 'ada',
    'The garden has a guided tour at 11, I checked.', '4 hours');

  // Meeting night — Demo Bram, open.
  await c(`INSERT INTO decisions (id, author_id, author_name, question, created_at, is_demo, demo_key)
           VALUES ('demo-meetings', $1, $2, 'Which night works best for meetings?', now() - interval '3 days', true, 'demo-meetings')
           ON CONFLICT DO NOTHING`, [...DEMO_PEOPLE.bram]);
  await c(`INSERT INTO choices (id, decision_id, label, position) VALUES
           ('demo-meetings-a', 'demo-meetings', 'Tuesday', 0),
           ('demo-meetings-b', 'demo-meetings', 'Wednesday', 1),
           ('demo-meetings-c', 'demo-meetings', 'Thursday', 2)
           ON CONFLICT DO NOTHING`);
  for (const [user, choice] of [
    ['demo-voter-1', 'demo-meetings-c'], ['demo-voter-2', 'demo-meetings-c'],
    ['demo-voter-3', 'demo-meetings-b'], ['demo-voter-4', 'demo-meetings-a'],
    ['demo-voter-5', 'demo-meetings-c'], ['demo-voter-6', 'demo-meetings-b'],
    ['demo-ada', 'demo-meetings-a'],
  ]) await vote('demo-meetings', user, choice);

  // Dues — Demo Marcus, decided (Yes won 11 to 4).
  await c(`INSERT INTO decisions (id, author_id, author_name, question, created_at, closed_at, is_demo, demo_key)
           VALUES ('demo-dues', $1, $2, 'Should season dues go up to $15?', now() - interval '8 days', now() - interval '2 days', true, 'demo-dues')
           ON CONFLICT DO NOTHING`, [...DEMO_PEOPLE.marcus]);
  await c(`INSERT INTO choices (id, decision_id, label, position) VALUES
           ('demo-dues-a', 'demo-dues', 'Yes, $15 a season', 0),
           ('demo-dues-b', 'demo-dues', 'Keep it at $10', 1)
           ON CONFLICT DO NOTHING`);
  for (const [user, choice] of [
    ['demo-voter-1', 'demo-dues-a'], ['demo-voter-2', 'demo-dues-a'],
    ['demo-voter-3', 'demo-dues-a'], ['demo-voter-4', 'demo-dues-a'],
    ['demo-voter-5', 'demo-dues-a'], ['demo-voter-6', 'demo-dues-a'],
    ['demo-voter-7', 'demo-dues-a'], ['demo-voter-8', 'demo-dues-a'],
    ['demo-voter-9', 'demo-dues-a'], ['demo-voter-10', 'demo-dues-a'],
    ['demo-voter-11', 'demo-dues-a'],
    ['demo-voter-12', 'demo-dues-b'], ['demo-voter-13', 'demo-dues-b'],
    ['demo-voter-14', 'demo-dues-b'], ['demo-voter-15', 'demo-dues-b'],
  ]) await vote('demo-dues', user, choice);
  await comment('demo-dues-c1', 'demo-dues', 'ada',
    'The extra $5 covers the room hire for the winter meetings.', '5 days');
  await comment('demo-dues-c2', 'demo-dues', 'bram',
    'Happy to pay it if the kit fund gets some too.', '3 days');
  await comment('demo-dues-c3', 'demo-dues', 'priya',
    'Can we keep a hardship rate for students?', '3 days');

  // Newsletter name — Demo Ada, decided (The Bulletin Board won outright).
  await c(`INSERT INTO decisions (id, author_id, author_name, question, created_at, closed_at, is_demo, demo_key)
           VALUES ('demo-newsletter', $1, $2, 'Pick a name for the newsletter', now() - interval '15 days', now() - interval '6 days', true, 'demo-newsletter')
           ON CONFLICT DO NOTHING`, [...DEMO_PEOPLE.ada]);
  await c(`INSERT INTO choices (id, decision_id, label, position) VALUES
           ('demo-newsletter-a', 'demo-newsletter', 'The Bulletin Board', 0),
           ('demo-newsletter-b', 'demo-newsletter', 'Club Notes', 1),
           ('demo-newsletter-c', 'demo-newsletter', 'The Gavel', 2)
           ON CONFLICT DO NOTHING`);
  for (const [user, choice] of [
    ['demo-voter-1', 'demo-newsletter-a'], ['demo-voter-2', 'demo-newsletter-a'],
    ['demo-voter-3', 'demo-newsletter-a'], ['demo-voter-4', 'demo-newsletter-a'],
    ['demo-voter-5', 'demo-newsletter-a'], ['demo-voter-6', 'demo-newsletter-a'],
    ['demo-voter-7', 'demo-newsletter-a'],
    ['demo-voter-8', 'demo-newsletter-b'], ['demo-voter-9', 'demo-newsletter-b'],
    ['demo-voter-10', 'demo-newsletter-b'],
    ['demo-voter-11', 'demo-newsletter-c'], ['demo-voter-12', 'demo-newsletter-c'],
  ]) await vote('demo-newsletter', user, choice);
  await comment('demo-newsletter-c1', 'demo-newsletter', 'marcus',
    'The Bulletin Board reads like us, plain and useful.', '5 days');
}

// The viewer's own demo question, written once on their first ?demo=1
// request, keyed to their user id.
async function seedViewerDemo(user) {
  const key = 'kickoff:' + user.id;
  const id = 'demo-kickoff-' + user.id;
  await pool.query(
    `INSERT INTO decisions (id, author_id, author_name, question, created_at, is_demo, demo_key)
     VALUES ($1, $2, $3, 'Where should we hold the spring kickoff?', now() - interval '2 days', true, $4)
     ON CONFLICT DO NOTHING`,
    [id, user.id, user.username, key]);
  await pool.query(
    `INSERT INTO choices (id, decision_id, label, position) VALUES
     ('demo-kickoff-a', $1, 'Back room at Fern Street Library', 0),
     ('demo-kickoff-b', $1, 'Riverside pavilion', 1),
     ('demo-kickoff-c', $1, 'Juniper''s Cafe upstairs', 2)
     ON CONFLICT DO NOTHING`, [id]);
  // Library 5 (the viewer plus four), pavilion 3, cafe 1.
  for (const [voter, choice] of [
    ['demo-ada', 'demo-kickoff-a'], ['demo-voter-1', 'demo-kickoff-a'],
    ['demo-voter-2', 'demo-kickoff-a'], ['demo-voter-3', 'demo-kickoff-a'],
    ['demo-voter-4', 'demo-kickoff-a'],
    ['demo-bram', 'demo-kickoff-b'], ['demo-voter-5', 'demo-kickoff-b'],
    ['demo-voter-6', 'demo-kickoff-b'],
    ['demo-priya', 'demo-kickoff-c'],
  ]) await pool.query(
    `INSERT INTO votes (decision_id, user_id, choice_id, updated_at)
     VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING`, [id, voter, choice]);
  // The viewer's own vote: DO NOTHING, so a vote they changed stays changed.
  await pool.query(
    `INSERT INTO votes (decision_id, user_id, choice_id, updated_at)
     VALUES ($1, $2, 'demo-kickoff-a', now()) ON CONFLICT DO NOTHING`,
    [id, user.id]);
  for (const [cid, who, body, at] of [
    ['demo-kickoff-c1', 'ada', 'The library room has the projector, so slides work there.', '26 hours'],
    ['demo-kickoff-c2', 'bram', "Pavilion is nicer if it stays dry, but it's a gamble in March.", '25 hours'],
  ]) await pool.query(
    `INSERT INTO comments (id, decision_id, author_id, author_name, body, created_at)
     VALUES ($1, $2, $3, $4, $5, now() - $6::interval) ON CONFLICT (id) DO NOTHING`,
    [cid, id, DEMO_PEOPLE[who][0], DEMO_PEOPLE[who][1], body, at]);
  await pool.query(
    `INSERT INTO comments (id, decision_id, author_id, author_name, body, created_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '3 hours') ON CONFLICT (id) DO NOTHING`,
    ['demo-kickoff-c3', id, user.id, user.username, "I'll book the library if it's still ahead on Friday."]);
}

// ── Routes ───────────────────────────────────────────────────────────────
const LIMITS = { question: 200, choice: 80, comment: 500 };

function decisionToJson(d, choices, viewerId) {
  const closed = !!d.closed_at;
  const voted = d.my_choice_id != null;
  const showCounts = closed || voted;
  let result = null;
  if (closed) {
    const withCounts = choices.map(c => ({ label: c.label, n: Number(c.count) }));
    const top = Math.max(...withCounts.map(c => c.n), 0);
    if (top === 0) result = { kind: 'none' };
    else {
      const winners = withCounts.filter(c => c.n === top);
      const rest = withCounts.filter(c => c.n < top);
      const second = rest.length ? Math.max(...rest.map(c => c.n)) : top;
      if (winners.length > 1) result = { kind: 'tie', labels: winners.map(w => w.label), count: top };
      else result = { kind: 'winner', label: winners[0].label, top, second };
    }
  }
  return {
    id: d.id,
    author_id: d.author_id,
    author_name: d.author_name,
    question: d.question,
    created_at: d.created_at,
    closed_at: d.closed_at,
    is_mine: viewerId != null && String(d.author_id) === String(viewerId),
    my_choice_id: voted ? d.my_choice_id : null,
    voters: Number(d.voters),
    comment_count: Number(d.comment_count),
    show_counts: showCounts,
    choices: choices.map(c => ({
      id: c.id, label: c.label, position: c.position,
      count: showCounts ? Number(c.count) : null,
    })),
    result,
  };
}

async function loadDecisions(req, { id = null } = {}) {
  const demo = IS_STAGING && req.query.demo === '1';
  const viewerId = req.user ? req.user.id : null;
  if (demo && req.user) await seedViewerDemo(req.user);

  const params = [demo, viewerId];
  let where = '($1 = true OR NOT d.is_demo)';
  if (id != null) { where += ' AND d.id = $3'; params.push(id); }
  const { rows } = await pool.query(`
    SELECT d.id, d.author_id, d.author_name, d.question, d.created_at, d.closed_at,
           (d.author_id = $2::text) AS is_mine,
           v.choice_id AS my_choice_id,
           (SELECT count(*) FROM votes xv WHERE xv.decision_id = d.id) AS voters,
           (SELECT count(*) FROM comments xc WHERE xc.decision_id = d.id) AS comment_count
    FROM decisions d
    LEFT JOIN votes v ON v.decision_id = d.id AND v.user_id = $2::text
    WHERE ${where}
    ORDER BY (d.closed_at IS NULL) DESC, COALESCE(d.closed_at, d.created_at) DESC`,
    params);

  const ids = rows.map(r => r.id);
  const { rows: choiceRows } = await pool.query(`
    SELECT c.id, c.decision_id, c.label, c.position,
           (SELECT count(*) FROM votes xv WHERE xv.choice_id = c.id) AS count
    FROM choices c
    WHERE c.decision_id = ANY($1::text[])
    ORDER BY c.decision_id, c.position`, [ids]);

  const byDecision = new Map();
  for (const c of choiceRows) {
    if (!byDecision.has(c.decision_id)) byDecision.set(c.decision_id, []);
    byDecision.get(c.decision_id).push(c);
  }
  return rows.map(r => decisionToJson(r, byDecision.get(r.id) || [], viewerId));
}

app.get('/api/decisions', async (req, res) => {
  try {
    const decisions = await loadDecisions(req);
    res.json({ signed_in: !!req.user, viewer_id: req.user ? req.user.id : null, demo: IS_STAGING && req.query.demo === '1', decisions });
  } catch (err) {
    console.error('GET /api/decisions failed: ' + (err.stack || err.message));
    res.status(500).json({ error: 'Could not load the questions.' });
  }
});

app.post('/api/decisions', async (req, res) => {
  const question = typeof req.body.question === 'string' ? req.body.question.trim() : '';
  const rawChoices = Array.isArray(req.body.choices) ? req.body.choices : [];
  const choices = rawChoices
    .filter(c => typeof c === 'string' && c.trim())
    .map(c => c.trim());
  if (!question || question.length > LIMITS.question) {
    return res.status(400).json({ error: 'Write a question of up to 200 characters.' });
  }
  if (choices.length < 2) {
    return res.status(400).json({ error: 'Give at least two choices.' });
  }
  if (choices.length > 8 || choices.some(c => c.length > LIMITS.choice)) {
    return res.status(400).json({ error: 'Each choice can be up to 80 characters, and a question can have up to 8 choices.' });
  }
  try {
    const id = require('crypto').randomUUID();
    await pool.query(
      `INSERT INTO decisions (id, author_id, author_name, question, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, req.user.id, req.user.username, question, req.now]);
    await pool.query(
      `INSERT INTO choices (id, decision_id, label, position)
       SELECT $1 || '-' || (ord - 1), $1, label, ord - 1
       FROM unnest($2::text[]) WITH ORDINALITY AS t(label, ord)`,
      [id, choices]);
    const [decision] = await loadDecisions(req, { id });
    res.status(201).json(decision);
  } catch (err) {
    console.error('POST /api/decisions failed: ' + err.message);
    res.status(500).json({ error: 'The question could not be posted. Nothing was lost, please try again.' });
  }
});

app.post('/api/decisions/:id/vote', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, c.id IS NOT NULL AS valid_choice
       FROM decisions d
       LEFT JOIN choices c ON c.decision_id = d.id AND c.id = $2
       WHERE d.id = $1`, [req.params.id, req.body.choice_id || null]);
    if (!rows.length) return res.status(404).json({ error: 'This question is gone.' });
    if (rows[0].closed_at) return res.status(409).json({ error: 'This vote is closed.' });
    if (!rows[0].valid_choice) return res.status(409).json({ error: 'That is not one of the choices.' });
    await pool.query(
      `INSERT INTO votes (decision_id, user_id, choice_id, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (decision_id, user_id)
       DO UPDATE SET choice_id = EXCLUDED.choice_id, updated_at = EXCLUDED.updated_at`,
      [req.params.id, req.user.id, req.body.choice_id, req.now]);
    const [decision] = await loadDecisions(req, { id: req.params.id });
    res.json(decision);
  } catch (err) {
    console.error('POST vote failed: ' + err.message);
    res.status(500).json({ error: 'The vote could not be saved, please try again.' });
  }
});

app.post('/api/decisions/:id/close', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE decisions SET closed_at = $3
       WHERE id = $1 AND author_id = $2 AND closed_at IS NULL
       RETURNING id`, [req.params.id, req.user.id, req.now]);
    if (!rows.length) return res.status(403).json({ error: 'Only whoever asked the question can close it.' });
    const [decision] = await loadDecisions(req, { id: req.params.id });
    res.json(decision);
  } catch (err) {
    console.error('POST close failed: ' + err.message);
    res.status(500).json({ error: 'The vote could not be closed, please try again.' });
  }
});

app.delete('/api/decisions/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM decisions WHERE id = $1 AND author_id = $2`,
      [req.params.id, req.user.id]);
    if (!rowCount) return res.status(403).json({ error: 'Only whoever asked the question can delete it.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE decision failed: ' + err.message);
    res.status(500).json({ error: 'The question could not be deleted, please try again.' });
  }
});

app.get('/api/decisions/:id/comments', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, author_id, author_name, body, created_at
       FROM comments WHERE decision_id = $1 ORDER BY created_at`,
      [req.params.id]);
    res.json({ comments: rows });
  } catch (err) {
    console.error('GET comments failed: ' + err.message);
    res.status(500).json({ error: 'The comments could not be loaded, please try again.' });
  }
});

app.post('/api/decisions/:id/comments', async (req, res) => {
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
  if (!body || body.length > LIMITS.comment) {
    return res.status(400).json({ error: 'Write a comment of up to 500 characters.' });
  }
  try {
    const owner = await pool.query(
      `SELECT id FROM decisions WHERE id = $1`, [req.params.id]);
    if (!owner.rowCount) return res.status(404).json({ error: 'This question is gone.' });
    const { rows } = await pool.query(
      `INSERT INTO comments (id, decision_id, author_id, author_name, body, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, author_id, author_name, body, created_at`,
      [require('crypto').randomUUID(), req.params.id, req.user.id, req.user.username, body, req.now]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST comment failed: ' + err.message);
    res.status(500).json({ error: 'The comment could not be added, please try again.' });
  }
});

app.delete('/api/comments/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM comments WHERE id = $1 AND author_id = $2`,
      [req.params.id, req.user.id]);
    if (!rowCount) return res.status(403).json({ error: 'You can only delete your own comments.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE comment failed: ' + err.message);
    res.status(500).json({ error: 'The comment could not be deleted, please try again.' });
  }
});

app.post('/api/reports', async (req, res) => {
  const type = req.body.target_type;
  const target = typeof req.body.target_id === 'string' ? req.body.target_id : '';
  if ((type !== 'decision' && type !== 'comment') || !target) {
    return res.status(400).json({ error: 'Nothing to report was given.' });
  }
  try {
    const owner = await pool.query(
      type === 'decision'
        ? `SELECT 1 FROM decisions WHERE id = $1`
        : `SELECT 1 FROM comments WHERE id = $1`, [target]);
    if (!owner.rowCount) return res.status(404).json({ error: 'That thing is gone.' });
    await pool.query(
      `INSERT INTO reports (reporter_id, target_type, target_id, created_at)
       VALUES ($1, $2, $3, $4)`, [req.user.id, type, target, req.now]);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST report failed: ' + err.message);
    res.status(500).json({ error: 'The report could not be sent, please try again.' });
  }
});


// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/club-votes-b7cc89/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/club-votes-b7cc89/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await ensureSchema();
  if (IS_STAGING) {
    try {
      await seedDemo();
    } catch (err) {
      console.warn('demo seed failed (continuing without it): ' + err.message);
    }
  }
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // Stop accepting, let in-flight requests drain, close the pool, exit.
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => { });
    setTimeout(() => pool.end().then(() => process.exit(0)), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });
