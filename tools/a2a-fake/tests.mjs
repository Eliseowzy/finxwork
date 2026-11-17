#!/usr/bin/env node
// Self-test for the A2A fake: starts it on an ephemeral port and drives every scenario.
// Run: node tools/a2a-fake/tests.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const API_KEY = 'test-key';
const servers = [];

function start(extraArgs = []) {
  const { PUBLIC_URL, ...env } = process.env;
  const child = spawn(process.execPath, [SERVER, '--port', '0', ...extraArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const line = new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`server did not start\n${stderr}`)), 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const end = stdout.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      resolve(stdout.slice(0, end));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}\n${stderr}`));
    });
  });

  return line.then((text) => {
    assert.match(text, /^listening on http:\/\/localhost:\d+$/, `startup line was ${text}`);
    const server = { child, base: text.slice('listening on '.length), stderr: () => stderr };
    servers.push(server);
    return server;
  });
}

async function stop(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await Promise.race([once(server.child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
}

function endpoint(base) {
  const url = new URL(base);
  return url.pathname === '/' ? `${base}/a2a` : base;
}

function rpcHeaders(extra = {}) {
  return { 'content-type': 'application/json', 'a2a-version': '1.0', ...extra };
}

async function rpc(base, method, params, options = {}) {
  const headers = rpcHeaders(options.headers);
  if (options.omitVersion) delete headers['a2a-version'];
  const response = await fetch(options.url ?? endpoint(base), {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: options.id ?? '1', method, params }),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: response.status, body };
}

async function stream(base, params, options = {}) {
  const headers = rpcHeaders(options.headers);
  const response = await fetch(options.url ?? endpoint(base), {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: options.method ?? 'SendStreamingMessage', params }),
    signal: options.signal,
  });
  assert.equal(response.status, 200, `stream HTTP ${response.status}`);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  return response;
}

async function* sse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        yield JSON.parse(line.slice(5).trimStart());
      }
    }
  }
}

async function collect(response) {
  const events = [];
  for await (const event of sse(response)) events.push(event);
  return events;
}

function message(text, extra = {}) {
  return { message: { messageId: `m-${Math.random()}`, role: 'ROLE_USER', parts: [{ text }], ...extra } };
}

function reason(body) {
  return body?.error?.data?.[0]?.reason;
}

function taskOf(events) {
  return events.find((event) => event.result?.task)?.result.task;
}

function finalStatus(events) {
  const updates = events.filter((event) => event.result?.statusUpdate);
  return updates.at(-1)?.result.statusUpdate;
}

function artifactText(events) {
  return events
    .filter((event) => event.result?.artifactUpdate)
    .flatMap((event) => event.result.artifactUpdate.artifact.parts.map((part) => part.text ?? ''))
    .join('');
}

async function main() {
  // ---- the default server: card, version header, hello and memory -------------
  const server = await start();
  const card = await (await fetch(`${server.base}/.well-known/agent-card.json`)).json();
  assert.equal(card.name, 'A2A Fake');
  assert.equal(card.supportedInterfaces.length, 1);
  assert.equal(card.supportedInterfaces[0].url, `${server.base}/a2a`);
  assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
  assert.equal(card.capabilities.streaming, true);
  assert.equal(card.skills.length, 2);
  assert.deepEqual(card.defaultInputModes, ['text/plain']);

  const noVersion = await rpc(server.base, 'SendStreamingMessage', message('hello'), { omitVersion: true });
  assert.equal(reason(noVersion.body), 'VERSION_NOT_SUPPORTED');

  const hello = await collect(await stream(server.base, message('hello')));
  const helloTask = taskOf(hello);
  assert.equal(hello[0].result.task.status.state, 'TASK_STATE_SUBMITTED');
  assert.ok(helloTask.id && helloTask.contextId);
  assert.ok(hello.some((event) => event.result?.statusUpdate?.status.state === 'TASK_STATE_WORKING'));
  assert.equal(artifactText(hello), 'hello (1)');
  const helloDone = finalStatus(hello);
  assert.equal(helloDone.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(helloDone.status.message.parts[0].text, 'hello (1)');
  const lastArtifact = hello.filter((event) => event.result?.artifactUpdate).at(-1);
  assert.equal(lastArtifact.result.artifactUpdate.lastChunk, true);

  // The root path and the advertised interface path both accept JSON-RPC.
  const onRoot = await collect(await stream(server.base, message('hello'), { url: `${server.base}/` }));
  assert.equal(finalStatus(onRoot).status.state, 'TASK_STATE_COMPLETED');

  const second = await collect(await stream(server.base, message('hello', { contextId: helloTask.contextId })));
  assert.equal(artifactText(second), 'hello (2)');
  const memory = await collect(await stream(server.base, message('What did I say before?', { contextId: helloTask.contextId })));
  assert.match(artifactText(memory), /hello \(3\); you said: hello \/ hello/);

  // ---- file scenarios ---------------------------------------------------------
  const file = await collect(await stream(server.base, message('file')));
  const filePart = file.find((event) => event.result?.artifactUpdate).result.artifactUpdate.artifact.parts[0];
  assert.equal(filePart.filename, 'fake.pdf');
  assert.equal(filePart.mediaType, 'application/pdf');
  assert.match(Buffer.from(filePart.raw, 'base64').toString(), /^%PDF/);

  const hostile = await collect(await stream(server.base, message('file2')));
  assert.equal(hostile.find((event) => event.result?.artifactUpdate).result.artifactUpdate.artifact.parts[0].filename, '../../x');

  const fileUrl = await collect(await stream(server.base, message('file-url')));
  const urlPart = fileUrl.find((event) => event.result?.artifactUpdate).result.artifactUpdate.artifact.parts[0];
  assert.equal(urlPart.url, 'https://example.com/fake.pdf');

  const fileData = await collect(await stream(server.base, message('file-data')));
  const dataPart = fileData.find((event) => event.result?.artifactUpdate).result.artifactUpdate.artifact.parts[0];
  assert.deepEqual(dataPart.data, { hello: 'world', n: 1 });

  const big = await collect(await stream(server.base, message('file-big')));
  const bigPart = big.find((event) => event.result?.artifactUpdate).result.artifactUpdate.artifact.parts[0];
  assert.equal(Buffer.from(bigPart.raw, 'base64').length, 1024 * 1024);
  assert.equal(finalStatus(big).status.state, 'TASK_STATE_COMPLETED');

  // ---- ask --------------------------------------------------------------------
  const asked = await collect(await stream(server.base, message('ask')));
  const askTask = taskOf(asked);
  const question = finalStatus(asked);
  assert.equal(question.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(question.status.message.parts[0].text, 'What is your name?');
  assert.equal(asked.at(-1).result.statusUpdate.taskId, askTask.id);
  const answered = await collect(await stream(server.base, message('Eliseo', { taskId: askTask.id, contextId: askTask.contextId })));
  assert.equal(finalStatus(answered).status.state, 'TASK_STATE_COMPLETED');
  assert.equal(artifactText(answered), 'thanks, Eliseo');
  assert.equal(finalStatus(answered).status.message.parts[0].text, 'thanks, Eliseo');

  // ---- empty, fail, reject, unknown ------------------------------------------
  const empty = await collect(await stream(server.base, message('empty')));
  assert.equal(finalStatus(empty).status.state, 'TASK_STATE_COMPLETED');
  assert.equal(finalStatus(empty).status.message, undefined);
  assert.equal(empty.some((event) => event.result?.artifactUpdate), false);

  const failed = await collect(await stream(server.base, message('fail')));
  assert.equal(finalStatus(failed).status.state, 'TASK_STATE_FAILED');
  assert.equal(finalStatus(failed).status.message.parts[0].text, 'the fake failed');

  const rejected = await collect(await stream(server.base, message('reject')));
  assert.equal(finalStatus(rejected).status.state, 'TASK_STATE_REJECTED');
  assert.equal(finalStatus(rejected).status.message, undefined);

  const unknown = await collect(await stream(server.base, message('unknown')));
  assert.ok(unknown.some((event) => event.result?.statusUpdate?.status.state === 'TASK_STATE_SOMETHING_NEW'));
  assert.equal(finalStatus(unknown).status.state, 'TASK_STATE_COMPLETED');
  assert.equal(artifactText(unknown), 'hello (1)');

  // ---- cancel, drop, hang -----------------------------------------------------
  const cancelResponse = await stream(server.base, message('cancel-me'));
  const cancelIterator = sse(cancelResponse)[Symbol.asyncIterator]();
  const submit = (await cancelIterator.next()).value;
  const working = (await cancelIterator.next()).value;
  assert.equal(submit.result.task.status.state, 'TASK_STATE_SUBMITTED');
  assert.equal(working.result.statusUpdate.status.state, 'TASK_STATE_WORKING');
  const cancelTask = submit.result.task;
  const canceled = await rpc(server.base, 'CancelTask', { id: cancelTask.id });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.result.status.state, 'TASK_STATE_CANCELED');
  const afterCancel = [];
  for (;;) {
    const next = await cancelIterator.next();
    if (next.done) break;
    afterCancel.push(next.value);
  }
  assert.equal(finalStatus(afterCancel).status.state, 'TASK_STATE_CANCELED');

  const dropped = await stream(server.base, message('drop'));
  const dropEvents = [];
  let dropBroke = false;
  try {
    for await (const event of sse(dropped)) dropEvents.push(event);
  } catch {
    dropBroke = true;
  }
  assert.equal(dropBroke, true, 'drop must break the stream');
  const dropTask = taskOf(dropEvents);
  assert.ok(dropTask, 'drop sent task before breaking');
  assert.ok(dropEvents.length >= 3, 'drop sent working and fragments before breaking');
  const droppedTask = await rpc(server.base, 'GetTask', { id: dropTask.id });
  assert.equal(droppedTask.body.result.status.state, 'TASK_STATE_WORKING');
  const resumed = await collect(await stream(server.base, { id: dropTask.id }, { method: 'SubscribeToTask' }));
  assert.equal(finalStatus(resumed).status.state, 'TASK_STATE_COMPLETED');
  assert.equal(resumed.filter((event) => event.result?.artifactUpdate).at(-1).result.artifactUpdate.lastChunk, true);
  const droppedDone = await rpc(server.base, 'GetTask', { id: dropTask.id });
  assert.equal(droppedDone.body.result.status.state, 'TASK_STATE_COMPLETED');

  const controller = new AbortController();
  const hangResponse = await stream(server.base, message('hang'), { signal: controller.signal });
  const hangIterator = sse(hangResponse)[Symbol.asyncIterator]();
  const hangSubmit = (await hangIterator.next()).value;
  const hangWorking = (await hangIterator.next()).value;
  assert.equal(hangWorking.result.statusUpdate.status.state, 'TASK_STATE_WORKING');
  const hung = await rpc(server.base, 'GetTask', { id: hangSubmit.result.task.id });
  assert.equal(hung.body.result.status.state, 'TASK_STATE_WORKING');
  controller.abort();

  // ---- task lookups, subscribe, errors ---------------------------------------
  const unknownTask = await rpc(server.base, 'GetTask', { id: 'no-such-task' });
  assert.equal(reason(unknownTask.body), 'TASK_NOT_FOUND');
  const finished = await rpc(server.base, 'GetTask', { id: helloTask.id });
  assert.equal(finished.body.result.status.state, 'TASK_STATE_COMPLETED');
  const subscribed = await rpc(server.base, 'SubscribeToTask', { id: helloTask.id });
  assert.equal(reason(subscribed.body), 'UNSUPPORTED_OPERATION');
  const recancel = await rpc(server.base, 'CancelTask', { id: helloTask.id });
  assert.equal(reason(recancel.body), 'TASK_NOT_CANCELABLE');

  const refused = await rpc(server.base, 'SendStreamingMessage', message('hello', { contextId: 'old-context' }));
  assert.equal(reason(refused.body), 'TASK_NOT_FOUND');

  const unknownMethod = await rpc(server.base, 'ListTasks', {});
  assert.equal(reason(unknownMethod.body), 'UNSUPPORTED_OPERATION');

  // ---- non-streaming reply ----------------------------------------------------
  const nostream = await rpc(server.base, 'SendMessage', message('nostream'));
  const flatTask = nostream.body.result.task;
  assert.equal(flatTask.status.state, 'TASK_STATE_COMPLETED');
  assert.ok(flatTask.artifacts[0].parts.length > 1);
  assert.equal(flatTask.artifacts[0].parts.map((part) => part.text).join(' '), 'nostream (1)');
  assert.equal(flatTask.status.message.parts[0].text, 'nostream (1)');

  // ---- redirect / cross-host card routes -------------------------------------
  const redirect = await fetch(`${server.base}/redirect`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'http://example.com/');
  const elsewhere = await (await fetch(`${server.base}/card-elsewhere`)).json();
  assert.equal(new URL(elsewhere.supportedInterfaces[0].url).host, 'example.com');
  await stop(server);

  // ---- --auth -----------------------------------------------------------------
  const authServer = await start(['--auth']);
  const authCard = await (await fetch(`${authServer.base}/.well-known/agent-card.json`)).json();
  assert.equal(authCard.securitySchemes.key.apiKeySecurityScheme.name, 'X-API-Key');
  assert.deepEqual(authCard.securityRequirements, [{ schemes: { key: { list: [] } } }]);

  const missing = await fetch(endpoint(authServer.base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'SendStreamingMessage', params: message('hello') }),
  });
  assert.equal(missing.status, 401);
  const wrong = await rpc(authServer.base, 'SendStreamingMessage', message('hello'), { headers: { 'x-api-key': 'wrong' } });
  assert.equal(wrong.status, 401);
  const allowed = await collect(await stream(authServer.base, message('hello'), { headers: { 'x-api-key': API_KEY } }));
  assert.equal(artifactText(allowed), 'hello (1)');
  const midway = await collect(await stream(authServer.base, message('auth-midway'), { headers: { 'x-api-key': API_KEY } }));
  assert.equal(finalStatus(midway).status.state, 'TASK_STATE_AUTH_REQUIRED');
  await stop(authServer);

  // ---- --no-streaming ---------------------------------------------------------
  const flatServer = await start(['--no-streaming']);
  const flatCard = await (await fetch(`${flatServer.base}/.well-known/agent-card.json`)).json();
  assert.equal(flatCard.capabilities.streaming, false);
  const noStream = await rpc(flatServer.base, 'SendStreamingMessage', message('hello'));
  assert.equal(reason(noStream.body), 'UNSUPPORTED_OPERATION');
  const flatReply = await rpc(flatServer.base, 'SendMessage', message('nostream'));
  assert.equal(flatReply.body.result.task.status.state, 'TASK_STATE_COMPLETED');
  await stop(flatServer);

  // ---- --provider / --icon ----------------------------------------------------
  const decorated = await start(['--provider', '--icon']);
  const decoratedCard = await (await fetch(`${decorated.base}/.well-known/agent-card.json`)).json();
  assert.equal(decoratedCard.provider.organization, 'A2A Fake');
  assert.equal(decoratedCard.iconUrl, `${decorated.base}/icon.png`);
  const iconResponse = await fetch(decoratedCard.iconUrl);
  assert.equal(iconResponse.status, 200);
  assert.match(iconResponse.headers.get('content-type') ?? '', /image\/png/);
  const iconBytes = Buffer.from(await iconResponse.arrayBuffer());
  assert.deepEqual([...iconBytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  await stop(decorated);

  console.log('all checks passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all(servers.map((server) => stop(server)));
  });