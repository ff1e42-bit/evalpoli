const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = process.env.PORT || 3000;

// ── Default state ──────────────────────────────────────────────
const mkDefault = () => ({
  config: {
    courseName: '',
    passwordHash: '',
    areas: [
      { id: 'a1', name: 'Completezza e Innovazione' },
      { id: 'a2', name: 'Innovazione' },
      { id: 'a3', name: 'Esposizione' }
    ],
    weights: { professor: 3, assistant: 2, companyRep: 1 },
    scoreMin: 0,
    scoreMax: 30
  },
  sessions: [],
  students: [],   // { id, name, brief, codicePersona, driveUrl }
  professors: [],
  assistants: [],
  companyReps: [],
  exams: [
    { id: 'exam_default', name: 'Prima Prova', driveUrl: '', evaluations: [] }
  ]
});

let state = mkDefault();

// Migrate old format (top-level evaluations) to new exams structure
function migrate(s) {
  if (s.evaluations !== undefined && !s.exams) {
    s.exams = [{
      id: 'exam_default',
      name: 'Prima Prova',
      driveUrl: '',
      evaluations: (s.evaluations || []).map(ev => ({
        ...ev,
        lodes: ev.lodes || {}
      }))
    }];
    delete s.evaluations;
  }
  if (!s.exams || s.exams.length === 0) {
    s.exams = [{ id: 'exam_default', name: 'Prima Prova', driveUrl: '', evaluations: [] }];
  }
  // Ensure all evaluations have lodes field
  s.exams.forEach(ex => {
    ex.evaluations = (ex.evaluations || []).map(ev => ({ lodes: {}, ...ev }));
  });
  return s;
}

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      let d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      d = migrate(d);
      state = { ...mkDefault(), ...d, config: { ...mkDefault().config, ...d.config } };
    }
  } catch (e) { console.error('Load error:', e); }
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  io.emit('state', publicState());
}

function publicState() {
  const { passwordHash, ...cfg } = state.config;
  return {
    config: cfg,
    sessions: state.sessions,
    students: state.students,
    professors: state.professors,
    assistants: state.assistants,
    companyReps: state.companyReps,
    exams: state.exams
  };
}

const hashPw = pw => crypto.createHash('sha256').update(pw + '_evalpoli_salt').digest('hex');
const uid = () => `p_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;

load();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const auth = (req, res, next) =>
  req.headers['x-token'] === state.config.passwordHash
    ? next()
    : res.status(401).json({ error: 'Unauthorized' });

// ── Auth ───────────────────────────────────────────────────────
app.get('/api/status', (_, res) =>
  res.json({ hasPassword: !!state.config.passwordHash }));

app.post('/api/setup', (req, res) => {
  if (state.config.passwordHash) return res.status(403).json({ error: 'Already configured' });
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: 'Min 4 characters' });
  state.config.passwordHash = hashPw(password);
  save();
  res.json({ token: state.config.passwordHash });
});

app.post('/api/login', (req, res) => {
  const h = hashPw(req.body.password || '');
  if (h !== state.config.passwordHash) return res.status(401).json({ error: 'Password errata' });
  res.json({ token: h });
});

app.put('/api/password', auth, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: 'Min 4 characters' });
  state.config.passwordHash = hashPw(password);
  save();
  res.json({ token: state.config.passwordHash });
});

// ── Full state ──────────────────────────────────────────────────
app.get('/api/state', auth, (_, res) => res.json(publicState()));

app.put('/api/state', auth, (req, res) => {
  const oldHash = state.config.passwordHash;
  let ns = { ...mkDefault(), ...req.body, config: { ...mkDefault().config, ...(req.body.config || {}), passwordHash: oldHash } };
  ns = migrate(ns);
  state = ns;
  save();
  res.json({ ok: true });
});

// ── Config ─────────────────────────────────────────────────────
app.put('/api/config', auth, (req, res) => {
  const { passwordHash, ...rest } = req.body;
  Object.assign(state.config, rest);
  save();
  res.json({ ok: true });
});

// ── People ─────────────────────────────────────────────────────
['students', 'professors', 'assistants', 'companyReps'].forEach(key => {
  app.put(`/api/${key}`, auth, (req, res) => {
    state[key] = req.body;
    save();
    res.json({ ok: true });
  });

  app.post(`/api/${key}`, auth, (req, res) => {
    const item = { id: uid(), ...req.body };
    state[key].push(item);
    save();
    res.json(item);
  });

  app.delete(`/api/${key}/:id`, auth, (req, res) => {
    const id = req.params.id;
    state[key] = state[key].filter(p => p.id !== id);
    state.sessions.forEach(s =>
      ['professorIds', 'assistantIds', 'companyRepIds', 'studentIds'].forEach(k => {
        if (s[k]) s[k] = s[k].filter(x => x !== id);
      })
    );
    state.exams.forEach(ex => {
      if (key === 'students') ex.evaluations = ex.evaluations.filter(e => e.studentId !== id);
      else ex.evaluations = ex.evaluations.filter(e => e.evaluatorId !== id);
    });
    save();
    res.json({ ok: true });
  });
});

// ── Sessions ───────────────────────────────────────────────────
app.post('/api/sessions', auth, (req, res) => {
  const s = { id: `s_${Date.now()}`, studentIds: [], professorIds: [], assistantIds: [], companyRepIds: [], ...req.body };
  state.sessions.push(s);
  save();
  res.json(s);
});

app.put('/api/sessions/:id', auth, (req, res) => {
  const i = state.sessions.findIndex(s => s.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  Object.assign(state.sessions[i], req.body);
  save();
  res.json(state.sessions[i]);
});

app.delete('/api/sessions/:id', auth, (req, res) => {
  state.sessions = state.sessions.filter(s => s.id !== req.params.id);
  save();
  res.json({ ok: true });
});

// Divide students among sessions (alternating | half | brief)
app.post('/api/divide', auth, (req, res) => {
  const { method } = req.body;
  const n = state.sessions.length;
  if (n < 1) return res.json({ ok: true });
  state.sessions.forEach(s => { s.studentIds = []; });

  if (method === 'brief') {
    const groups = {};
    state.students.forEach(st => {
      const key = st.brief || '\x00'; // \x00 = no brief, goes first
      if (!groups[key]) groups[key] = [];
      groups[key].push(st.id);
    });
    Object.values(groups).forEach((group, i) => {
      const idx = i % n;
      group.forEach(id => state.sessions[idx].studentIds.push(id));
    });
  } else {
    state.students.forEach((st, i) => {
      const idx = method === 'alternating'
        ? i % n
        : Math.min(Math.floor((i / state.students.length) * n), n - 1);
      state.sessions[idx].studentIds.push(st.id);
    });
  }
  save();
  res.json({ ok: true });
});

// ── Exams ──────────────────────────────────────────────────────
app.post('/api/exams', auth, (req, res) => {
  const exam = {
    id: `exam_${Date.now()}`,
    name: req.body.name || 'Nuova Prova',
    driveUrl: req.body.driveUrl || '',
    evaluations: []
  };
  state.exams.push(exam);
  save();
  res.json(exam);
});

app.put('/api/exams/:id', auth, (req, res) => {
  const exam = state.exams.find(e => e.id === req.params.id);
  if (!exam) return res.status(404).json({ error: 'Not found' });
  if (req.body.name !== undefined) exam.name = req.body.name;
  if (req.body.driveUrl !== undefined) exam.driveUrl = req.body.driveUrl;
  save();
  res.json(exam);
});

app.delete('/api/exams/:id', auth, (req, res) => {
  if (state.exams.length <= 1) return res.status(400).json({ error: 'Deve esistere almeno una prova' });
  state.exams = state.exams.filter(e => e.id !== req.params.id);
  save();
  res.json({ ok: true });
});

app.put('/api/exams/:id/evaluations', auth, (req, res) => {
  const exam = state.exams.find(e => e.id === req.params.id);
  if (!exam) return res.status(404).json({ error: 'Not found' });

  const { studentId, evaluatorId, evaluatorType, scores, lodes, comment } = req.body;
  let ev = exam.evaluations.find(e => e.studentId === studentId && e.evaluatorId === evaluatorId);
  if (!ev) {
    ev = { id: `e_${Date.now()}`, studentId, evaluatorId, evaluatorType, scores: {}, lodes: {}, comment: '' };
    exam.evaluations.push(ev);
  }
  if (scores) {
    Object.entries(scores).forEach(([k, v]) => {
      if (v === null || v === '' || v === undefined) delete ev.scores[k];
      else ev.scores[k] = Number(v);
    });
  }
  if (lodes) {
    Object.entries(lodes).forEach(([k, v]) => {
      if (!v) delete (ev.lodes = ev.lodes || {})[k];
      else (ev.lodes = ev.lodes || {})[k] = true;
    });
  }
  if (comment !== undefined) ev.comment = comment;
  save();
  res.json(ev);
});

// ── Socket.io ──────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Disconnected:', socket.id));
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✓ EvalPoli → http://localhost:${PORT}\n`);
});
