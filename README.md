# VC-Bajju

GitHub Pages frontend for the Bajju VC coordination desk. The configured Google
Apps Script bridge handles signed access challenges and spreadsheet operations.

## Approval connection recovery

`approval-transport.js` serializes challenge/request pairs. After a mobile page
is suspended or restored from the back-forward cache, the next request rebuilds
the Google iframe connection. A failed access challenge can retry on a fresh
connection; it cannot approve a notice. Read-only `state` requests can also retry.

If a mutation's response is lost (HTTP 0, network failure, or timeout), the client
does **not** replay it. The UI reads the saved state and asks the user to review
the result. Recovery never opens Shortcuts or WhatsApp and never marks a notice
sent. Prepared approvals are labeled separately from reviews awaiting approval.
The client timeout is 420 seconds, exceeding Google’s 390-second bridge callback
window; the previous 180-second limit could abandon a still-running request.
Authentication, recipient/revision validation, manual approval, and send
confirmation remain in place.

The screenshot's HTTP 0 identifies a missing usable response, not proof that the
server did nothing. The original mobile interruption's underlying cause has not
been reproduced. This change handles the broken/stale bridge and ambiguous
response safely; it cannot guarantee network availability or message delivery.

## Tests

Run `node --test tests/*.test.cjs` with Node.js 18 or newer. Tests use fake
transports and never contact the live backend, alter records, or send messages.
They cover challenge recovery, uncertain mutations, bounded retries, concurrent
requests, permission errors, and the SMS/WhatsApp UI recovery paths.
