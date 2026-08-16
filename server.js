import express from 'express';

const app = express();
const port = Number(process.env.PORT || 10000);
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

function auth(req, res, next) {
  const expected = process.env.AGENT_AUTH_TOKEN;
  if (!expected) return next();
  const supplied = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (supplied !== expected) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const modes = [
  { id: 'research', label: 'Research', description: 'Research and verify information before proposing changes.' },
  { id: 'code', label: 'Code', description: 'Inspect a repository and implement a focused engineering task.' },
  { id: 'bug', label: 'Fix Bug', description: 'Reproduce, diagnose, fix, and validate a bug.' },
  { id: 'test', label: 'Test', description: 'Audit builds, tests, routes, and likely regressions.' },
  { id: 'data', label: 'University Data', description: 'Research, normalize, validate, and prepare university records.' },
  { id: 'audit', label: 'Audit', description: 'Review architecture, security, UX, data, and technical debt.' }
];

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'agent-1', version: '0.1.0' }));
app.get('/api/config', auth, (_req, res) => res.json({
  modes,
  repositories: [
    { id: 'topuni', label: 'TopUni', repo: `${process.env.GITHUB_OWNER || 'topuniuz'}/${process.env.TOPUNI_REPO || 'topuni'}` },
    { id: 'topapp', label: 'TopApp', repo: `${process.env.GITHUB_OWNER || 'topuniuz'}/${process.env.TOPAPP_REPO || 'topapp'}` },
    { id: 'both', label: 'Both', repo: 'TopUni + TopApp' }
  ],
  actions: [
    { id: 'analyze', label: 'Analyze only' },
    { id: 'modify', label: 'Make changes' },
    { id: 'test', label: 'Make + test' },
    { id: 'commit', label: 'Make + test + commit' },
    { id: 'push', label: 'Make + test + commit + push to main' }
  ],
  integrations: { github: Boolean(process.env.GITHUB_TOKEN), gemini: Boolean(process.env.GEMINI_API_KEY) }
}));

// This first release is intentionally a safe control-plane shell. AI/GitHub execution is enabled only
// after credentials are configured and the operator explicitly chooses an action level.
app.post('/api/tasks', auth, async (req, res) => {
  const { mode, repository, action, task } = req.body || {};
  if (!modes.some(m => m.id === mode)) return res.status(400).json({ error: 'Invalid mode' });
  if (!['topuni', 'topapp', 'both'].includes(repository)) return res.status(400).json({ error: 'Invalid repository' });
  if (!['analyze', 'modify', 'test', 'commit', 'push'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  if (!task || typeof task !== 'string') return res.status(400).json({ error: 'Task description is required' });

  const missing = [];
  if (!process.env.GITHUB_TOKEN) missing.push('GITHUB_TOKEN');
  if (!process.env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
  if (missing.length) return res.status(503).json({
    status: 'configuration_required',
    message: 'Agent runtime is ready. Add the required environment variables before executing repository work.',
    missing
  });

  res.status(202).json({
    status: 'queued',
    task: { mode, repository, action, description: task },
    message: 'Execution engine is configured for this task. The next runtime phase will analyze the repository before making any change.'
  });
});

app.listen(port, () => console.log(`Agent 1 listening on ${port}`));
