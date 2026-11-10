/**
 * The pages behind the links in password-reset and account-recovery emails.
 *
 * Those emails link to `/reset-password?token=…` and `/recover?token=…` on
 * this server. Nothing served either path, so the links led nowhere and a
 * user could not finish a reset from the email. These are the missing pages:
 * a form that takes the new password and sends it, with the token from the
 * link, to the XRPC method that does the work.
 *
 * The page carries no inline script (the server's Content-Security-Policy
 * allows scripts from this origin only); the behaviour lives in
 * `/account-forms.js`. The token is read from the URL by that script and is
 * never written into the HTML.
 */
import { Router, type Request, type Response } from 'express';

const FLOWS = {
  '/reset-password': {
    title: 'Choose a new password',
    intro: 'Enter a new password for your account. You will be signed out everywhere and can sign in again with the new password.',
    method: 'net.openfederation.account.confirmPasswordReset',
    done: 'Your password has been changed. You can now sign in with the new password.',
  },
  '/recover': {
    title: 'Recover your account',
    intro: 'Enter a new password to regain access to your account. All existing sessions will be signed out.',
    method: 'net.openfederation.account.completeRecovery',
    done: 'Your account has been recovered. You can now sign in with the new password.',
  },
} as const;

function page(flow: (typeof FLOWS)[keyof typeof FLOWS]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${flow.title}</title>
</head>
<body style="font-family: sans-serif; max-width: 420px; margin: 4rem auto; padding: 0 1rem;">
<h2>${flow.title}</h2>
<p>${flow.intro}</p>
<form id="account-form" data-method="${flow.method}" data-done="${flow.done}">
  <p><label>New password<br>
    <input type="password" name="newPassword" autocomplete="new-password" required minlength="10" style="width: 100%; padding: .5rem; box-sizing: border-box;"></label></p>
  <p><label>Repeat new password<br>
    <input type="password" name="repeat" autocomplete="new-password" required minlength="10" style="width: 100%; padding: .5rem; box-sizing: border-box;"></label></p>
  <p><button type="submit" style="padding: .6rem 1.2rem;">Save new password</button></p>
</form>
<p id="account-form-status" role="status" aria-live="polite"></p>
<noscript><p>This page needs JavaScript to submit the form.</p></noscript>
<script src="/account-forms.js"></script>
</body>
</html>`;
}

const FORM_SCRIPT = `(function () {
  var form = document.getElementById('account-form');
  var status = document.getElementById('account-form-status');
  if (!form || !status) return;
  var token = new URLSearchParams(window.location.search).get('token') || '';
  function say(text, ok) {
    status.textContent = text;
    status.style.color = ok ? '#188038' : '#c5221f';
  }
  if (!token) {
    form.hidden = true;
    say('This link is incomplete. Copy the full address from the email.', false);
    return;
  }
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var newPassword = form.elements.newPassword.value;
    if (newPassword !== form.elements.repeat.value) {
      say('The two passwords do not match.', false);
      return;
    }
    var button = form.querySelector('button');
    button.disabled = true;
    say('Saving...', true);
    fetch('/xrpc/' + form.dataset.method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, newPassword: newPassword }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (res.ok) {
          form.hidden = true;
          say(form.dataset.done, true);
          return;
        }
        button.disabled = false;
        say(body.message || 'That did not work. The link may have expired or already been used.', false);
      });
    }).catch(function () {
      button.disabled = false;
      say('Could not reach the server. Check your connection and try again.', false);
    });
  });
})();
`;

export function createAccountPagesRouter(): Router {
  const router = Router();

  for (const path of Object.keys(FLOWS) as Array<keyof typeof FLOWS>) {
    router.get(path, (_req: Request, res: Response) => {
      // The address carries a one-time secret: keep it out of caches and referrers.
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.status(200).type('html').send(page(FLOWS[path]));
    });
  }

  router.get('/account-forms.js', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).type('application/javascript').send(FORM_SCRIPT);
  });

  return router;
}
