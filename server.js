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
  { id: 'code', label: 'Code', description: 'Inspect the repository and implement a focused engineering task.' },
  { id: 'bug', label: 'Fix Bug', description: 'Reproduce, diagnose, fix, and validate a bug.' },
  { id: 'test', label: 'Test', description: 'Audit builds, tests, routes, and likely regressions.' },
  { id: 'data', label: 'University Data', description: 'Research, normalize, validate, and prepare university records.' },
  { id: 'audit', label: 'Audit', description: 'Review architecture, security, UX, data, and technical debt.' }
];

function requireIntegrations(res) {
  const missing = [];
  if (!process.env.GITHUB_TOKEN) missing.push('GITHUB_TOKEN');
  if (!process.env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
  if (missing.length) {
    res.status(503).json({
      status: 'configuration_required',
      message: 'Agent runtime is ready. Add the required environment variables before executing repository work.',
      missing
    });
    return false;
  }
  return true;
}

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text }; }
  if (!response.ok) throw new Error(data.message || `GitHub request failed (${response.status})`);
  return data;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'agent-1', version: '0.2.0' }));

app.get('/api/config', auth, (_req, res) => res.json({
  modes,
  actions: [
    { id: 'analyze', label: 'Analyze' },
    { id: 'preview', label: 'Implement + Preview' },
    { id: 'publish', label: 'Approve → Main' }
  ],
  integrations: { github: Boolean(process.env.GITHUB_TOKEN), gemini: Boolean(process.env.GEMINI_API_KEY) }
}));

app.get('/api/repositories', auth, async (_req, res) => {
  if (!process.env.GITHUB_TOKEN) return res.status(503).json({ error: 'GITHUB_TOKEN is not configured.' });
  try {
    const repositories = await github('/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=updated');
    res.json({ repositories: repositories.map(repo => ({
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      private: repo.private,
      default_branch: repo.default_branch,
      permissions: repo.permissions || {}
    })) });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/tasks', auth, async (req, res) => {
  const { mode, repository, action, task } = req.body || {};
  if (!modes.some(m => m.id === mode)) return res.status(400).json({ error: 'Invalid mode' });
  if (!repository || typeof repository !== 'string' || !repository.includes('/')) return res.status(400).json({ error: 'Select a repository' });
  if (!['analyze', 'preview', 'publish'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  if (!task || typeof task !== 'string') return res.status(400).json({ error: 'Task description is required' });
  if (!requireIntegrations(res)) return;

  // Repository execution is deliberately gated. The next engine phase will clone the selected
  // repository, let Gemini plan/apply the minimal patch, run validation, and create a reviewable
  // preview. Publishing to main will require a separate explicit approval action.
  if (action === 'publish') {
    return res.status(409).json({
      status: 'approval_required',
      message: 'Publishing is a separate approval step. First create and review the preview for this task.'
    });
  }

  res.status(202).json({
    status: 'queued',
    task: { mode, repository, action, description: task },
    message: action === 'analyze'
      ? 'Repository selected. Analysis job is ready to run.'
      : 'Preview job is ready. Agent will analyze the full repository before editing and will not publish to main automatically.'
  });
});

app.listen(port, () => console.log(`Agent 1 listening on ${port}`));
