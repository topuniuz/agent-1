import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const app = express();
const port = Number(process.env.PORT || 10000);
const jobs = new Map();
app.use(express.json({ limit: '2mb' }));
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
  { id: 'bug', label: 'Fix Bug', description: 'Diagnose, fix, test, and prepare a reviewable change.' },
  { id: 'test', label: 'Test', description: 'Audit builds, tests, routes, and likely regressions.' },
  { id: 'data', label: 'University Data', description: 'Research, normalize, validate, and prepare university records.' },
  { id: 'audit', label: 'Audit', description: 'Review architecture, security, UX, data, and technical debt.' }
];

const planSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    relevantFiles: { type: 'array', items: { type: 'string' } },
    edits: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    tests: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  },
  required: ['summary', 'risks', 'relevantFiles', 'edits', 'tests', 'confidence'],
  additionalProperties: false
};

const repairSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    edits: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    risks: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  },
  required: ['summary', 'edits', 'risks', 'confidence'],
  additionalProperties: false
};

function requireIntegrations(res) {
  const missing = [];
  if (!process.env.GITHUB_TOKEN) missing.push('GITHUB_TOKEN');
  if (!process.env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
  if (missing.length) {
    res.status(503).json({ status: 'configuration_required', message: 'Add the required environment variables before executing repository work.', missing });
    return false;
  }
  return true;
}

async function github(apiPath, options = {}) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2026-03-10',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text }; }
  if (!response.ok) throw new Error(data.message || `GitHub request failed (${response.status})`);
  return data;
}

async function gemini(prompt, schema) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const makeRequest = async (extraPrompt = '') => {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${prompt}${extraPrompt}` }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema
        }
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Gemini request failed (${response.status})`);
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!text) throw new Error('Gemini returned no usable response.');
    return { data, text };
  };

  let result = await makeRequest();
  try {
    return JSON.parse(result.text);
  } catch {
    result = await makeRequest('\n\nIMPORTANT: return ONLY a valid JSON object matching the response schema. Do not include markdown, code fences, or commentary.');
    try {
      return JSON.parse(result.text);
    } catch {
      throw new Error('Gemini returned invalid structured output after retry.');
    }
  }
}

async function run(cmd, args, cwd, timeout = 120000) {
  return exec(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 });
}

function safeBranchName(task) {
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'task';
  return `agent-1/${slug}-${Date.now().toString(36)}`;
}

function log(job, message, status = null) {
  job.events ||= [];
  job.events.push({ at: Date.now(), message, status });
  job.updatedAt = Date.now();
}

function setStatus(job, status, message = null) {
  job.status = status;
  job.updatedAt = Date.now();
  if (message) log(job, message, status);
}

async function collectFiles(root) {
  const { stdout } = await run('git', ['ls-files'], root, 30000);
  return stdout.split('\n').map(x => x.trim()).filter(Boolean).filter(x => !/(^|\/)(node_modules|\.git|dist|build|coverage)(\/|$)/.test(x));
}

async function readRelevantFiles(root, files) {
  const ranked = files.map(file => ({ file, score: /(^|\/)(package\.json|vite\.config|next\.config|src\/|app\/|pages\/|server|README|supabase|\.github\/)/i.test(file) ? 2 : 1 }));
  ranked.sort((a, b) => b.score - a.score || a.file.length - b.file.length);
  const selected = ranked.slice(0, 100);
  let total = 0;
  const chunks = [];
  for (const { file } of selected) {
    try {
      const content = await readFile(path.join(root, file), 'utf8');
      if (content.length > 30000) continue;
      if (total + content.length > 300000) break;
      chunks.push(`\n--- FILE: ${file} ---\n${content}`);
      total += content.length;
    } catch {}
  }
  return { selected: selected.map(x => x.file), snapshot: chunks.join('') };
}

async function applyEdits(root, edits) {
  const changed = [];
  for (const edit of edits || []) {
    if (!edit?.path || typeof edit.content !== 'string') continue;
    const normalized = path.normalize(edit.path);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) throw new Error(`Unsafe edit path: ${edit.path}`);
    if (normalized.includes('node_modules') || normalized === '.git') throw new Error(`Blocked edit path: ${edit.path}`);
    const target = path.join(root, normalized);
    await writeFile(target, edit.content, 'utf8');
    changed.push(normalized);
  }
  return [...new Set(changed)];
}

async function createPr(repository, branch, base, task, summary) {
  const [owner, repo] = repository.split('/');
  return github(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: `Agent 1: ${task.slice(0, 70)}`,
      head: branch,
      base,
      body: `## Agent 1\n\n${summary}\n\nThis branch was created by Agent 1 for review. It is not published to main automatically.`,
      draft: false
    })
  });
}

async function mergePr(repository, number) {
  const [owner, repo] = repository.split('/');
  return github(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/merge`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merge_method: 'squash' })
  });
}

function getTestCommands(packageJson) {
  const commands = [];
  const scripts = packageJson?.scripts || {};
  if (scripts.test) commands.push(['npm', ['test']]);
  if (scripts.build) commands.push(['npm', ['run', 'build']]);
  return commands.slice(0, 2);
}

async function runValidation(work) {
  const pkgPath = path.join(work, 'package.json');
  let packageJson = null;
  try { packageJson = JSON.parse(await readFile(pkgPath, 'utf8')); } catch {}
  const commands = getTestCommands(packageJson);
  const testResults = [];
  for (const [cmd, args] of commands) {
    try {
      const result = await run(cmd, args, work, 240000);
      testResults.push({ command: [cmd, ...args].join(' '), ok: true, output: `${result.stdout || ''}\n${result.stderr || ''}`.slice(-12000) });
    } catch (error) {
      testResults.push({ command: [cmd, ...args].join(' '), ok: false, code: error.code ?? null, output: `${error.stdout || ''}\n${error.stderr || error.message}`.slice(-12000) });
    }
  }
  return testResults;
}

async function repairFromValidation(job, work, files, snapshot, testResults) {
  const failures = testResults.filter(x => !x.ok);
  if (!failures.length) return [];
  const changed = job.changedFiles || [];
  const changedSnapshot = [];
  for (const file of changed) {
    try { changedSnapshot.push(`\n--- CHANGED FILE: ${file} ---\n${await readFile(path.join(work, file), 'utf8')}`); } catch {}
  }
  const repair = await gemini(`You are Agent 1 repairing your own code change. The project validation failed. Return only structured JSON matching the supplied schema. Fix only the failures while preserving the requested behavior and unrelated code. Do not change configuration merely to hide failures.\n\nTASK: ${job.task}\n\nFAILURES:\n${failures.map(x => `COMMAND: ${x.command}\nOUTPUT:\n${x.output}`).join('\n')}\n\nCHANGED FILES:\n${changedSnapshot.join('')}\n\nREPOSITORY FILES:\n${files.join('\n')}\n\nRELEVANT SNAPSHOT:\n${snapshot}`, repairSchema);
  const repaired = await applyEdits(work, repair.edits || []);
  if (repaired.length) job.changedFiles = [...new Set([...changed, ...repaired])];
  job.repair = { summary: repair.summary || 'Applied a validation repair pass.', confidence: repair.confidence ?? null, files: repaired };
  return repaired;
}

async function executeJob(job) {
  const work = await mkdtemp(path.join(tmpdir(), 'agent1-'));
  try {
    setStatus(job, 'cloning', 'cloning repository into isolated workspace');
    const repoUrl = `https://x-access-token:${encodeURIComponent(process.env.GITHUB_TOKEN)}@github.com/${job.repository}.git`;
    await run('git', ['clone', '--depth', '1', repoUrl, work], tmpdir(), 180000);
    const { stdout: currentSha } = await run('git', ['rev-parse', 'HEAD'], work, 30000);
    const { stdout: baseBranch } = await run('git', ['branch', '--show-current'], work, 30000);
    job.baseBranch = baseBranch.trim() || 'main';
    job.baseSha = currentSha.trim();

    const files = await collectFiles(work);
    setStatus(job, 'analyzing', `analyzing repository structure and relevant source files (${files.length} files)`);
    job.fileCount = files.length;
    const snapshotData = await readRelevantFiles(work, files);
    const plan = await gemini(`You are Agent 1, a careful senior software engineer. Analyze this repository snapshot and the user's task. Return only structured JSON matching the supplied schema. Make the smallest safe change. Preserve unrelated functionality. Do not invent files. For research/test/audit tasks, edits may be empty. For code/bug tasks, provide complete contents only for files that must change.\n\nMODE: ${job.mode}\nTASK: ${job.task}\n\nREPOSITORY FILE LIST:\n${files.join('\n')}\n\nRELEVANT FILE SNAPSHOT:\n${snapshotData.snapshot}`, planSchema);
    job.plan = { summary: plan.summary, risks: plan.risks || [], relevantFiles: plan.relevantFiles || [], confidence: plan.confidence ?? null };

    if (job.action === 'analyze') {
      setStatus(job, 'analysis_complete', 'analysis complete; no files modified and no pull request created');
      return;
    }

    setStatus(job, 'editing', 'Gemini produced a plan; applying targeted edits');
    const changed = await applyEdits(work, plan.edits || []);
    job.changedFiles = changed;
    if (!changed.length) {
      setStatus(job, 'analysis_complete', 'no changes were required; no branch or pull request created');
      return;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      setStatus(job, 'testing', attempt === 1 ? 'running project tests and build validation' : `validation failed; running repair pass ${attempt - 1}/2`);
      job.tests = await runValidation(work);
      if (!job.tests.some(x => !x.ok)) break;
      if (attempt === 3) {
        job.error = 'Validation failed after two repair attempts. No branch or pull request was published.';
        setStatus(job, 'failed', 'execution failed — validation still failing; no main publication');
        return;
      }
      await repairFromValidation(job, work, files, snapshotData.snapshot, job.tests);
    }

    setStatus(job, 'publishing_branch', 'tests passed; creating agent branch and publishing review commit');
    job.branch = safeBranchName(job.task);
    await run('git', ['checkout', '-b', job.branch], work, 30000);
    await run('git', ['config', 'user.name', 'Agent 1'], work, 30000);
    await run('git', ['config', 'user.email', 'agent-1@users.noreply.github.com'], work, 30000);
    await run('git', ['add', ...job.changedFiles], work, 30000);
    await run('git', ['commit', '-m', `feat(agent-1): ${job.task.slice(0, 60)}`], work, 60000);
    await run('git', ['push', '-u', 'origin', job.branch], work, 120000);

    const pr = await createPr(job.repository, job.branch, job.baseBranch, job.task, plan.summary || 'Agent 1 completed a reviewable change.');
    job.pr = { number: pr.number, url: pr.html_url, title: pr.title };
    setStatus(job, 'ready_for_review', 'validation complete; GitHub PR is ready for your review');
  } catch (error) {
    job.error = error.message;
    setStatus(job, 'failed', `execution failed — ${error.message}`);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'agent-1', version: '0.5.0' }));
app.get('/api/config', auth, (_req, res) => res.json({
  modes,
  actions: [
    { id: 'analyze', label: 'Analyze' },
    { id: 'preview', label: 'Implement + Preview' },
    { id: 'publish', label: 'Approve → Main' }
  ],
  integrations: { github: Boolean(process.env.GITHUB_TOKEN), gemini: Boolean(process.env.GEMINI_API_KEY), render: Boolean(process.env.RENDER_API_KEY) }
}));

app.get('/api/repositories', auth, async (_req, res) => {
  if (!process.env.GITHUB_TOKEN) return res.status(503).json({ error: 'GITHUB_TOKEN is not configured.' });
  try {
    const repositories = await github('/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=updated');
    res.json({ repositories: repositories.map(repo => ({ id: repo.id, name: repo.name, full_name: repo.full_name, private: repo.private, default_branch: repo.default_branch, permissions: repo.permissions || {} })) });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/tasks', auth, async (req, res) => {
  const { mode, repository, action, task } = req.body || {};
  if (!modes.some(m => m.id === mode)) return res.status(400).json({ error: 'Invalid mode' });
  if (!repository || typeof repository !== 'string' || !/^[^/]+\/[^/]+$/.test(repository)) return res.status(400).json({ error: 'Select a repository' });
  if (!['analyze', 'preview'].includes(action)) return res.status(400).json({ error: 'Use preview first; publishing is an approval action.' });
  if (!task || typeof task !== 'string') return res.status(400).json({ error: 'Task description is required' });
  if (!requireIntegrations(res)) return;
  const id = crypto.randomUUID();
  const job = { id, mode, repository, action, task: task.slice(0, 10000), status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), events: [] };
  jobs.set(id, job);
  log(job, 'job accepted');
  executeJob(job);
  res.status(202).json({ jobId: id, status: job.status, message: 'Agent 1 started. It will analyze the full repository, make only required changes, run validation, and create a reviewable branch/PR.' });
});

app.get('/api/jobs/:id', auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found. Render free instances may restart and clear in-memory job history.' });
  res.json(job);
});

app.post('/api/jobs/:id/approve', auth, async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'ready_for_review' || !job.pr?.number) return res.status(409).json({ error: 'Job is not ready for approval.' });
  try {
    setStatus(job, 'publishing', 'approval received; merging approved PR into main');
    const result = await mergePr(job.repository, job.pr.number);
    job.status = result.merged ? 'published' : 'failed';
    job.merge = result;
    log(job, result.merged ? 'published successfully to main' : 'GitHub did not merge the pull request', result.merged ? 'published' : 'failed');
    res.json(job);
  } catch (error) {
    job.error = error.message;
    setStatus(job, 'failed', `publish failed — ${error.message}`);
    res.status(502).json({ error: error.message, job });
  }
});

app.post('/api/jobs/:id/cancel', auth, async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  job.status = 'cancelled';
  job.updatedAt = Date.now();
  log(job, 'job cancelled');
  if (job.pr?.number) {
    try { await github(`/repos/${job.repository}/pulls/${job.pr.number}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'closed' }) }); } catch {}
  }
  res.json(job);
});

app.post('/api/jobs/:id/revise', auth, async (req, res) => {
  const job = jobs.get(req.params.id);
  const instruction = req.body?.instruction;
  if (!job || !instruction) return res.status(400).json({ error: 'Job and revision instruction are required.' });
  if (job.pr?.number) {
    try { await github(`/repos/${job.repository}/pulls/${job.pr.number}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'closed' }) }); } catch {}
  }
  const next = { mode: job.mode, repository: job.repository, action: 'preview', task: `${job.task}\n\nREVISION REQUEST:\n${String(instruction).slice(0, 5000)}` };
  const id = crypto.randomUUID();
  const fresh = { id, ...next, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), events: [] };
  jobs.set(id, fresh);
  log(fresh, 'revision accepted');
  executeJob(fresh);
  res.status(202).json({ jobId: id, message: 'Revision started.' });
});

app.listen(port, '0.0.0.0', () => console.log(`Agent 1 listening on ${port}`));
