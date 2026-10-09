const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../approval-transport.js'), 'utf8'), context);
function setup(direct) {
  const events = [];
  const transport = context.createApprovalTransport({
    direct: async (...args) => { events.push(args); return direct(...args); },
    reconnect: async () => events.push(['reconnect']),
    credential: () => ({ id: 'device' }), sign: async () => 'signed',
    stage: () => {}, delay: async () => {}
  });
  return { transport, events };
}
const challenge = { id: 'challenge', message: 'bound action' };
test('HTTP 0 during challenge reconnects before exactly one approval dispatch', async () => {
  let failed = false;
  const { transport, events } = setup(async method => {
    if (method === 'portalAccess' && !failed) { failed = true; throw Error('NetworkError: Connection failure due to HTTP 0'); }
    return method === 'portalAccess' ? challenge : { approved: true };
  });
  assert.equal((await transport.request('approve', { method: 'SMS' })).approved, true);
  assert.deepEqual(events.map(e => e[0]), ['portalAccess', 'reconnect', 'portalAccess', 'portalRequest']);
});
for (const action of ['approve', 'sent', 'manual_vc', 'check', 'dismiss']) {
  test(`${action}: lost response never replays mutation; next state read reconnects`, async () => {
    const { transport, events } = setup(async (method, action) => {
      if (method === 'portalAccess') return challenge;
      if (action !== 'state') throw Error('NetworkError: Connection failure due to HTTP 0');
      return { saved: true };
    });
    await assert.rejects(transport.request(action), e => e.code === 'REQUEST_OUTCOME_UNKNOWN');
    assert.equal((await transport.request('state')).saved, true);
    assert.equal(events.filter(e => e[0] === 'portalRequest' && e[1] === action).length, 1);
    assert.equal(events.filter(e => e[0] === 'reconnect').length, 1);
  });
}
test('state reads may safely retry a lost response', async () => {
  let reads = 0;
  const { transport, events } = setup(async method => {
    if (method === 'portalAccess') return challenge;
    if (++reads === 1) throw Error('This request took too long. Its result is unknown; refresh before retrying the action.');
    return { reads };
  });
  assert.equal((await transport.request('state')).reads, 2);
  assert.equal(events.filter(e => e[0] === 'reconnect').length, 1);
});
test('concurrent RPCs cannot replace a bridge between challenge and mutation', async () => {
  let release;
  const gate = new Promise(resolve => release = resolve);
  const { transport, events } = setup(async (method, action) => {
    if (method === 'portalAccess') return challenge;
    if (action === 'approve') await gate;
    return {};
  });
  const approval = transport.request('approve');
  await new Promise(resolve => setImmediate(resolve));
  transport.invalidate();
  const state = transport.request('state');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.map(e => e[0]), ['portalAccess', 'portalRequest']);
  release(); await Promise.all([approval, state]);
  assert.deepEqual(events.map(e => e[0]), ['portalAccess', 'portalRequest', 'reconnect', 'portalAccess', 'portalRequest']);
});
test('permanent failure is bounded and never dispatches an approval', async () => {
  const { transport, events } = setup(async () => { throw Error('NetworkError'); });
  await assert.rejects(transport.request('approve'));
  assert.equal(events.filter(e => e[0] === 'portalAccess').length, 3);
  assert.equal(events.filter(e => e[0] === 'portalRequest').length, 0);
});
test('permission and validation errors are not retried', async () => {
  for (const message of ['ACCESS_REQUIRED', 'Host-only action.', 'The message or an officer changed.']) {
    const { transport, events } = setup(async () => { throw Error(message); });
    await assert.rejects(transport.request('approve'), e => e.message === message);
    assert.equal(events.length, 1);
  }
});
test('a post-dispatch busy error is not replayed', async () => {
  const { transport, events } = setup(async method => {
    if (method === 'portalAccess') return challenge;
    throw Error('Access service busy. Please retry.');
  });
  await assert.rejects(transport.request('approve'));
  assert.equal(events.filter(e => e[0] === 'portalRequest').length, 1);
});
test('expired authentication challenge can retry because verification precedes dispatch', async () => {
  let calls = 0;
  const { transport } = setup(async method => {
    if (method === 'portalAccess') return challenge;
    if (++calls === 1) throw Error('AUTH_CHALLENGE_EXPIRED');
    return { approved: true };
  });
  assert.equal((await transport.request('approve')).approved, true);
});
