/**
 * The page where a user approves a dApp's request to have this PDS sign with
 * their custodial wallet (see src/wallet/consent-requests.ts).
 *
 * It is served from the PDS's own origin and refuses to be framed, so the dApp
 * that made the request can link to it but not read, script or overlay it.
 * Everything the user is agreeing to is shown here, from the stored request,
 * not from anything the dApp passes along with the link.
 */
import { Router, type Request, type Response } from 'express';
import { getConsentRequest } from '../wallet/index.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
</head>
<body style="font-family: sans-serif; max-width: 480px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5;">
${body}
</body>
</html>`;
}

function weiDescription(value: bigint | null): string {
  if (value === null) return 'none';
  return `${value.toString()} wei`;
}

const CONSENT_SCRIPT = `(function () {
  var form = document.getElementById('consent-form');
  var status = document.getElementById('consent-status');
  if (!form || !status) return;
  function say(text, ok) { status.textContent = text; status.style.color = ok ? '#188038' : '#c5221f'; }
  function settle(approve) {
    var buttons = form.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    say(approve ? 'Approving...' : 'Declining...', true);
    fetch('/xrpc/net.openfederation.wallet.approveConsentRequest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: form.dataset.requestId, password: form.elements.password.value, approve: approve }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (res.ok) {
          form.hidden = true;
          say(approve ? 'Approved. You can close this page and return to the app.' : 'Declined. The app has not been given access.', approve);
          return;
        }
        for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
        say(body.message || 'That did not work.', false);
      });
    }).catch(function () {
      for (var k = 0; k < buttons.length; k++) buttons[k].disabled = false;
      say('Could not reach the server. Try again.', false);
    });
  }
  form.addEventListener('submit', function (event) { event.preventDefault(); settle(true); });
  document.getElementById('consent-deny').addEventListener('click', function () { settle(false); });
})();
`;

export function createWalletConsentRouter(): Router {
  const router = Router();

  router.get('/wallet/consent/:requestId', async (req: Request, res: Response) => {
    // Not frameable, not cached, no referrer: the address is a capability.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'");
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const request = await getConsentRequest(String(req.params.requestId));
    if (!request) {
      res.status(404).type('html').send(shell('Request not found', '<h2>Request not found</h2><p>This link does not match any request.</p>'));
      return;
    }
    if (request.status !== 'pending' || request.expired) {
      const what = request.status !== 'pending' ? `already ${request.status}` : 'expired';
      res.status(410).type('html').send(shell('Request closed', `<h2>This request is ${escapeHtml(what)}</h2><p>Ask the app to make a new one if you still want to give it access.</p>`));
      return;
    }

    const wallet = request.walletAddress
      ? `${escapeHtml(request.chain ?? '')} wallet <code>${escapeHtml(request.walletAddress)}</code>`
      : 'all of your custodial wallets';
    const contracts = request.scope.allowedContracts && request.scope.allowedContracts.length > 0
      ? `<ul>${request.scope.allowedContracts.map((c) => `<li><code>${escapeHtml(c)}</code></li>`).join('')}</ul>`
      : '<p><strong>None.</strong> It may only sign messages, not transactions.</p>';
    const hours = Math.round((request.ttlSeconds / 3600) * 10) / 10;

    const body = `
<h2>Allow this app to use your wallet?</h2>
<p><strong>${escapeHtml(request.dappOrigin)}</strong> is asking for permission to have this server sign on your behalf with ${wallet}.</p>
<h3>It could sign transactions to</h3>
${contracts}
<h3>Value it could move</h3>
<p>Per transaction: ${escapeHtml(weiDescription(request.scope.maxValuePerTx))}<br>
In total: ${escapeHtml(request.scope.maxTotalValue === null ? (request.scope.maxValuePerTx === null ? 'none' : 'no total limit') : weiDescription(request.scope.maxTotalValue))}</p>
<h3>For how long</h3>
<p>${escapeHtml(String(hours))} hour(s) after you approve. You can revoke it sooner at any time.</p>
<p>It will not be able to sign you in to any other site.</p>
<form id="consent-form" data-request-id="${escapeHtml(request.id)}">
  <p><label>Your account password<br>
    <input type="password" name="password" autocomplete="current-password" required style="width: 100%; padding: .5rem; box-sizing: border-box;"></label></p>
  <p><button type="submit" style="padding: .6rem 1.2rem;">Approve</button>
     <button type="button" id="consent-deny" style="padding: .6rem 1.2rem;">Decline</button></p>
</form>
<p id="consent-status" role="status" aria-live="polite"></p>
<noscript><p>This page needs JavaScript to submit your answer.</p></noscript>
<script src="/wallet-consent.js"></script>`;
    res.status(200).type('html').send(shell('Allow wallet access?', body));
  });

  router.get('/wallet-consent.js', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).type('application/javascript').send(CONSENT_SCRIPT);
  });

  return router;
}
