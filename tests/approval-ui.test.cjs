const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const transport = fs.readFileSync(path.join(__dirname, '../approval-transport.js'), 'utf8');
test('production page scripts parse and transport loads before use', () => {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  assert.ok(html.indexOf('src="approval-transport.js"') < html.indexOf('createApprovalTransport('));
});
test('bridge timeout exceeds Google callback window and rejects without replay', async () => {
  let timerCallback, timeout, posts = 0;
  const pending = new Map();
  const ctx = vm.createContext({
    ensureBridge: async () => {}, crypto: { randomUUID: () => 'request' },
    bridgePending: pending, bridgeSession: 'session', bridgeOrigin: 'https://fixture.invalid',
    bridgeWindow: { postMessage: () => posts++ },
    setTimeout: (fn, ms) => { timerCallback = fn; timeout = ms; return 1; }, clearTimeout: () => {}
  });
  vm.runInContext(html.slice(html.indexOf('async function direct('), html.indexOf('\nrestartBridge();')), ctx);
  const request = ctx.direct('portalRequest', 'approve');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timeout, 420000);
  assert.ok(timeout > 390000);
  assert.equal(pending.size, 1);
  timerCallback();
  await assert.rejects(request, /result is unknown/);
  assert.equal(pending.size, 0);
  assert.equal(posts, 1);
});
for (const method of ['SMS', 'WhatsApp']) {
  for (const readbackFails of [false, true]) {
    test(`${method}: lost approval response, readback ${readbackFails ? 'fails' : 'succeeds'}, no handoff`, async () => {
      const events = [];
      const elements = { '#modal': { hidden: false } };
      const ctx = vm.createContext({
        busy: false, handoff: null, review: { id: 'fixture' }, selection: new Set(['fixture']),
        state: null, view: 'desk',
        $: selector => elements[selector],
        document: { querySelectorAll: () => [] },
        render: () => events.push('render'), renderReview: () => events.push('renderReview'),
        close: () => { elements['#modal'].hidden = true; ctx.review = null; },
        modal: (title, body) => { elements['#modal'].hidden = false; events.push({ title, body }); },
        error: e => events.push({ error: e.message }), toast: s => events.push({ toast: s })
      });
      vm.runInContext(transport, ctx);
      const rpc = ctx.createApprovalTransport({
        direct: async (fn, action) => {
          events.push([fn, action]);
          if (fn === 'portalAccess') return { id: 'challenge', message: 'fixture' };
          if (action === 'approve' || readbackFails) throw Error('NetworkError: Connection failure due to HTTP 0');
          return { reviews: [{ ready: true }], resolved: [] };
        },
        reconnect: async () => events.push('reconnect'),
        credential: () => ({ id: 'device' }), sign: async () => 'signed', stage: () => {}, delay: async () => {}
      });
      ctx.rpc = (...args) => rpc.request(...args);
      const recovery = html.slice(html.indexOf('async function recoverUncertainAction('), html.indexOf('\nfunction credentialStore'));
      const perform = html.slice(html.indexOf('async function perform('), html.indexOf("\ndocument.addEventListener('click',e=>{const el=e.target.closest('button,a')"));
      vm.runInContext(recovery + '\n' + perform, ctx);
      await ctx.perform('approve', { method }, () => events.push('MESSAGE_HANDOFF'));
      assert.equal(events.includes('MESSAGE_HANDOFF'), false);
      assert.equal(events.filter(e => Array.isArray(e) && e[0] === 'portalRequest' && e[1] === 'approve').length, 1);
      assert.equal(ctx.busy, false);
      assert.equal(ctx.handoff, null);
      assert.ok(events.some(e => e.title === (readbackFails ? 'Saved result unavailable' : 'Check the saved result')));
      if (!readbackFails) assert.equal(ctx.state.reviews[0].ready, true);
    });
  }
}
