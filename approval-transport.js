/* Keep an access challenge and its signed request on the same bridge.
 * A lost mutation response is ambiguous: never replay the mutation.
 */
function createApprovalTransport({ direct, reconnect, sign, credential, stage, delay }) {
  let queue = Promise.resolve();
  let needsReconnect = false;
  const networkFailure = error => /NetworkError|HTTP\s*0\b|Failed to fetch|Load failed|connection failure|request took too long/i.test(error?.message || '');
  const accessBusy = error => /Access service busy|AUTH_CHALLENGE_EXPIRED/.test(error?.message || '');
  async function run(action, input) {
    const device = credential();
    if (!device?.id) throw Error('ACCESS_REQUIRED');
    for (let attempt = 0; attempt < 3; attempt++) {
      let dispatched = false;
      try {
        if (needsReconnect) {
          await reconnect();
          needsReconnect = false;
        }
        const challenge = await direct('portalAccess', 'challenge', { device: device.id, action, input });
        stage(action);
        const signature = await sign(challenge.message, device);
        dispatched = true;
        return await direct('portalRequest', action, input, { device: device.id, id: challenge.id, signature });
      } catch (error) {
        if (networkFailure(error)) {
          needsReconnect = true;
          if (dispatched && action !== 'state') {
            const uncertain = Error('The connection was interrupted. This action may already be saved. It was not retried. Refresh the saved record before approving or sending again.');
            uncertain.code = 'REQUEST_OUTCOME_UNKNOWN';
            uncertain.cause = error;
            throw uncertain;
          }
        }
        // A failed challenge cannot approve or send anything. Only state reads
        // may be replayed after dispatch; other actions require a new user action.
        const safeRetry = (!dispatched && (networkFailure(error) || accessBusy(error))) ||
          (action === 'state' && (networkFailure(error) || accessBusy(error))) ||
          (dispatched && /^(?:Error:\s*)?AUTH_CHALLENGE_EXPIRED$/.test(error.message));
        if (!safeRetry || attempt === 2) throw error;
        await delay(800 * (attempt + 1));
      }
    }
  }
  return {
    request(action, input = {}) {
      const next = queue.then(() => run(action, input));
      queue = next.catch(() => {});
      return next;
    },
    invalidate() { needsReconnect = true; }
  };
}
