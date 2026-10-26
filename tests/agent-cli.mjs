import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const binary = process.env.CLI_BINARY ?? `${homedir()}/.local/bin/oxroute-agent`;
const schema = process.env.SCHEMA_FILE ? JSON.parse(await readFile(process.env.SCHEMA_FILE, 'utf8'))
  : await (await fetch(`${process.env.OXROUTE_URL ?? 'http://127.0.0.1:8787'}/api/agent-openapi.json`)).json();
// An interchangeable route proves commands come from discovery, not an endpoint table in the CLI.
schema.paths['/api/widgets/{key}'] = { post: { operationId: 'widgets.inspect', parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { enabled: { type: 'boolean' }, optionalText: { type: ['string', 'null'] }, labels: { type: 'array', items: { type: 'string' } } } } } } } } };
const actor = 'agent-fixture', id = 'task /?# λ';
const task = { id, text: 'Keep the original task text.', status: 'blocked', parentTaskId: 'parent-fixture', blockedByTaskId: 'dependency-fixture', agentId: actor };
const requests = [];
const server = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString(), body = text ? JSON.parse(text) : null;
  const url = new URL(request.url, 'http://fixture.invalid');
  if (url.pathname === '/api/agent-openapi.json') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(schema)); return; }
  requests.push({ method: request.method, url, body });
  const result = url.pathname === '/api/tasks' && request.method === 'GET' ? [task, { ...task, id: 'foreign', agentId: 'another-agent' }]
    : url.pathname === '/api/task-notes' ? [{ taskId: id, text: 'Human feedback', agentId: '' }, { taskId: 'another-task', text: 'Other feedback' }]
    : { ...body, path: url.pathname, full: url.searchParams.get('full'), snapshot: { headCommit: 'fixture-head', files: ['Large content is omitted by projection'] } };
  if (url.pathname.includes('rejected')) { response.statusCode = 400; response.end(JSON.stringify({ error: 'Fixture request rejected' })); return; }
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const run = (args, bound = true) => new Promise((resolve, reject) => {
  const child = spawn(binary, ['--server', base, ...(bound ? ['--agent', actor] : []), ...args], { env: { ...process.env, OXROUTE_AGENT_ID: '' } });
  let out = '', error = '';
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
  child.on('error', reject); child.on('exit', status => resolve({ status, out, error }));
});
try {
  let result = await run(['tasks', 'list', '--fields', 'id,status']);
  assert.equal(result.status, 0, result.error);
  assert.deepEqual(JSON.parse(result.out), [{ id, status: 'blocked' }], 'The bound session receives its own tasks with only requested fields');
  result = await run(['tasks', 'list', '--all']);
  assert.equal(JSON.parse(result.out).length, 2, 'Other sessions remain available through --all');
  result = await run(['notes', 'list', '--filter', `taskId=${id}`, '--fields', 'text']);
  assert.deepEqual(JSON.parse(result.out), [{ text: 'Human feedback' }], 'Feedback from humans is preserved');
  result = await run(['tasks', 'update', '--id', id, '--status', 'done', '--note', 'Completed fixture work.']);
  assert.equal(result.status, 0, result.error);
  assert.deepEqual(requests.at(-1).body, { text: task.text, status: 'done', parentTaskId: task.parentTaskId, blockedByTaskId: '', agentId: actor, note: 'Completed fixture work.' }, 'Partial updates preserve task text and parent, bind the caller, and clear an obsolete blocker when leaving blocked');
  assert.ok(requests.at(-1).url.pathname.includes('%2F%3F'), 'Path values are encoded as a single segment');
  result = await run(['tasks', 'update', '--id', id, '--text', 'Refined task text.']);
  assert.equal(result.status, 0, result.error);
  assert.equal(requests.at(-1).body.blockedByTaskId, task.blockedByTaskId, 'Editing a blocked task preserves its dependency');
  result = await run(['notes', 'add', '--id', id, '--text', 'An audit note.']);
  assert.deepEqual(requests.at(-1).body, { agentId: actor, text: 'An audit note.' });
  result = await run(['reviews', 'show', '--review', 'review-fixture', '--full', 'true']);
  assert.equal(result.status, 0, result.error);
  assert.equal(requests.at(-1).url.pathname, `/api/agents/${actor}/reviews/review-fixture`);
  assert.equal(requests.at(-1).url.searchParams.get('full'), 'true');
  result = await run(['reviews', 'show', '--review', 'review-fixture', '--fields', 'snapshot.headCommit']);
  assert.deepEqual(JSON.parse(result.out), { 'snapshot.headCommit': 'fixture-head' }, 'Review metadata can be read without returning patch content to the agent');
  result = await run(['widgets', 'inspect', '--key', 'example', '--enabled', 'true', '--optional-text', 'A nullable string', '--labels', '["one","two"]']);
  assert.equal(result.status, 0, result.error);
  assert.deepEqual(requests.at(-1).body, { enabled: true, optionalText: 'A nullable string', labels: ['one', 'two'] }, 'New schema routes and typed fields work without changing the CLI');
  const mutations = () => requests.filter(request => request.method !== 'GET').length;
  const before = mutations();
  result = await run(['tasks', 'create', '--text', 'No caller'], false);
  assert.notEqual(result.status, 0);
  assert.match(result.error, /require.*agent/i);
  result = await run(['notes', 'add', '--id', id, '--json', '{"text":"Wrong actor","agentId":"someone-else"}']);
  assert.notEqual(result.status, 0);
  assert.equal(mutations(), before, 'Invalid identity never reaches a mutating endpoint');
  result = await run(['reviews', 'show', '--review', 'rejected']);
  assert.notEqual(result.status, 0); assert.match(result.error, /Fixture request rejected/);
  result = await run(['tasks', 'update', '--help']);
  assert.equal(result.status, 0); assert.ok(!result.out.includes('--approved'), 'Human task sign-off is not an agent command flag');
  result = await run(['reviews', '--help']);
  assert.equal(result.status, 0); assert.ok(!result.out.includes('approve'), 'Human review approval remains an explicit UI operation');
  console.log('CLI commands and flags follow live OpenAPI discovery, preserve task fields and human feedback, bind session identity, encode paths, and report HTTP failures.');
} finally { await new Promise(resolve => server.close(resolve)); }
