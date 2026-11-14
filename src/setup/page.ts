/**
 * The setup wizard's page (#405): one HTML document whose steps the script
 * shows one at a time. No inline script or event handler, so it works under
 * the server's Content-Security-Policy (script-src 'self').
 *
 * Wording rule: plain words, no unexplained jargon. Where a technical word is
 * unavoidable (DNS, SMTP) the page says what it is the first time it appears.
 */

const STEP_NAMES = ['Kind of server', 'Addresses', 'Email', 'Admin account', 'Options', 'Review'];

function progress(): string {
  return `<ol class="progress" id="progress" aria-label="Setup steps">
${STEP_NAMES.map((name, i) => `  <li data-step="${i + 1}"><span class="num">${i + 1}</span> <span class="label">${name}</span></li>`).join('\n')}
</ol>`;
}

export function renderSetupPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Set up your OpenFederation server</title>
<link rel="stylesheet" href="/setup/assets/setup.css">
</head>
<body>
<a class="skip" href="#main">Skip to the form</a>
<header class="top">
  <p class="brand">OpenFederation</p>
  <h1>Set up your server</h1>
</header>
<main id="main">
<noscript><p class="notice bad">This page needs JavaScript. Turn it on for this site and reload the page.</p></noscript>

<div id="loading" class="step" aria-live="polite"><p>Loading…</p></div>

<section class="step" id="step-locked" hidden aria-labelledby="h-locked">
  <h2 id="h-locked" tabindex="-1">This server was already set up</h2>
  <p>Setup was finished on this server before, but its settings file is missing now. The server will not offer setup again: new settings would come with new secret keys, and the keys already stored in the database could no longer be unlocked.</p>
  <p><strong>To fix it,</strong> put back the settings file you downloaded at the end of setup (its name is <code>openfederation.env</code>) at <code id="locked-path"></code>, or set the same values as environment variables, and restart the server.</p>
  <p>If you have no copy, ask for help in the OpenFederation project before doing anything else.</p>
</section>

<section class="step" id="step-claim" hidden aria-labelledby="h-claim">
  <h2 id="h-claim" tabindex="-1">First, show that this server is yours</h2>
  <p>This server is new and not set up yet. Setup takes about ten minutes: you choose the server's addresses, how it sends email, and the first admin account. Secret keys are created for you.</p>
  <p>When the server started, it wrote a <strong>setup code</strong> in its log. Only someone who can see the log can finish setup, so nobody else can take over your server.</p>
  <details>
    <summary>Where do I find the log?</summary>
    <ul>
      <li><strong>Railway:</strong> open your project, click the server (<em>openfederation-pds</em>), open <em>Deployments</em>, then <em>View logs</em>. Look for the line that says <em>Setup code</em>.</li>
      <li><strong>Docker:</strong> run <code>docker compose logs pds</code> and look for <em>Setup code</em>.</li>
    </ul>
    <p>The code changes every time the server restarts. Use the newest one.</p>
  </details>
  <form id="claim-form" novalidate>
    <div class="field">
      <label for="claim-code">Setup code</label>
      <input id="claim-code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" aria-describedby="claim-code-error" required>
      <p class="error" id="claim-code-error" hidden></p>
    </div>
    <button type="submit" class="primary">Continue</button>
  </form>
</section>

<div id="wizard" hidden>
${progress()}

<section class="step" id="step-1" hidden aria-labelledby="h-1">
  <h2 id="h-1" tabindex="-1">What kind of server is this?</h2>
  <p>This sets sensible starting choices. You can change the details on the Options step.</p>
  <form data-section="kind" novalidate>
    <fieldset>
      <legend class="visually-hidden">Kind of server</legend>
      <label class="choice"><input type="radio" name="kind" value="community">
        <span><strong>A community or club server</strong>
        <span class="hint">For groups, clubs, teams and fan communities. People sign up with a name and a password, and the server looks after their keys so nobody gets locked out. Anonymous accounts are off.</span></span></label>
      <label class="choice"><input type="radio" name="kind" value="privacy">
        <span><strong>A newsroom or privacy-first server</strong>
        <span class="hint">For journalists, their sources, and anyone who needs to protect who they are. People are encouraged to keep their own keys, and anonymous accounts (pseudonyms) are on.</span></span></label>
    </fieldset>
    <p class="error" data-error="kind" hidden></p>
    <div class="nav"><span></span><button type="submit" class="primary">Next</button></div>
  </form>
</section>

<section class="step" id="step-2" hidden aria-labelledby="h-2">
  <h2 id="h-2" tabindex="-1">Addresses</h2>
  <form data-section="addresses" novalidate>
    <div class="field">
      <label for="publicUrl">Server address</label>
      <p class="hint" id="publicUrl-hint">The web address of this server; people's apps connect here. To use your own domain, enter it, for example <code>https://pds.example.org</code>. The address you are on now is filled in.</p>
      <input id="publicUrl" name="publicUrl" type="url" inputmode="url" autocomplete="url" spellcheck="false" aria-describedby="publicUrl-hint publicUrl-error">
      <p class="error" data-error="publicUrl" id="publicUrl-error" hidden></p>
    </div>
    <div class="field">
      <label for="handleDomain">Name domain</label>
      <p class="hint" id="handleDomain-hint">Everyone here gets a name that ends with this domain, like <code>alice.<span class="domain-sample">example.org</span></code>. Use a domain you own. Changing it later changes everyone's name.</p>
      <input id="handleDomain" name="handleDomain" inputmode="url" autocomplete="off" spellcheck="false" placeholder="example.org" aria-describedby="handleDomain-hint handleDomain-error">
      <p class="error" data-error="handleDomain" id="handleDomain-error" hidden></p>
    </div>
    <div class="field">
      <label for="dashboardUrl">Dashboard address <span class="optional">(optional)</span></label>
      <p class="hint" id="dashboardUrl-hint">Where you and your members open the dashboard, the website for managing accounts and communities. Leave it empty if you do not use one.</p>
      <input id="dashboardUrl" name="dashboardUrl" type="url" inputmode="url" spellcheck="false" aria-describedby="dashboardUrl-hint dashboardUrl-error">
      <p class="error" data-error="dashboardUrl" id="dashboardUrl-error" hidden></p>
    </div>
    <details class="field" id="plc-details">
      <summary>Identity directory (most people leave this alone)</summary>
      <p class="hint">Every account gets a permanent ID that is listed in a public directory, so other servers can find it. Most servers use the OpenFederation directory. Change this only if you run your own.</p>
      <fieldset>
        <legend class="visually-hidden">Identity directory</legend>
        <label class="choice compact"><input type="radio" name="plcChoice" value="default" checked> <span>The OpenFederation directory (<code>plc.openfederation.net</code>)</span></label>
        <label class="choice compact"><input type="radio" name="plcChoice" value="own"> <span>My own directory</span></label>
      </fieldset>
      <div class="field" id="plcUrl-field" hidden>
        <label for="plcUrl">My directory's address</label>
        <input id="plcUrl" name="plcUrl" type="url" inputmode="url" spellcheck="false" aria-describedby="plcUrl-error">
        <p class="error" data-error="plcUrl" id="plcUrl-error" hidden></p>
      </div>
    </details>

    <div class="panel">
      <h3>Records to add at your domain provider</h3>
      <p class="hint">DNS records are entries you add where you bought your domain (your registrar or DNS provider). They send each address to the right place. New records can take from a few minutes to an hour to work. You can finish setup before they do.</p>
      <button type="button" id="dns-check">Show the records and check them</button>
      <div id="dns-output" aria-live="polite"></div>
    </div>
    <div class="nav"><button type="button" class="back">Back</button><button type="submit" class="primary">Next</button></div>
  </form>
</section>

<section class="step" id="step-3" hidden aria-labelledby="h-3">
  <h2 id="h-3" tabindex="-1">Email</h2>
  <p>The server sends email for password resets, account recovery, and warnings when someone signs in. For that it needs an account with an email sending service, for example Resend, Postmark, Mailgun or Amazon SES, or the outgoing mail settings (called SMTP) from your own email provider.</p>
  <form data-section="email" novalidate>
    <fieldset>
      <legend class="visually-hidden">How this server sends email</legend>
      <label class="choice compact"><input type="radio" name="mode" value="smtp"> <span><strong>Send email through my provider</strong> (recommended)</span></label>
      <label class="choice compact"><input type="radio" name="mode" value="none"> <span><strong>No email for now</strong></span></label>
    </fieldset>
    <p class="error" data-error="mode" hidden></p>
    <div id="smtp-fields" hidden>
      <p class="hint">Your email provider shows these values on its SMTP settings page.</p>
      <div class="field"><label for="smtp-host">Mail server</label>
        <input id="smtp-host" name="host" autocomplete="off" spellcheck="false" placeholder="smtp.example.com" aria-describedby="smtp-host-error">
        <p class="error" data-error="host" id="smtp-host-error" hidden></p></div>
      <div class="row">
        <div class="field"><label for="smtp-port">Port</label>
          <input id="smtp-port" name="port" inputmode="numeric" value="587" aria-describedby="smtp-port-error">
          <p class="error" data-error="port" id="smtp-port-error" hidden></p></div>
        <div class="field"><label for="smtp-security">Encryption</label>
          <select id="smtp-security" name="security">
            <option value="starttls">STARTTLS (usually port 587)</option>
            <option value="tls">TLS (usually port 465)</option>
          </select></div>
      </div>
      <div class="field"><label for="smtp-user">Username</label>
        <input id="smtp-user" name="user" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label for="smtp-password">Password</label>
        <input id="smtp-password" name="password" type="password" autocomplete="off" aria-describedby="smtp-password-error">
        <p class="error" data-error="password" id="smtp-password-error" hidden></p></div>
      <div class="field"><label for="smtp-from">Send emails from</label>
        <p class="hint" id="smtp-from-hint">The address people see emails coming from, like <code>noreply@example.org</code>. Your provider must allow sending from it.</p>
        <input id="smtp-from" name="from" type="email" autocomplete="off" spellcheck="false" aria-describedby="smtp-from-hint smtp-from-error">
        <p class="error" data-error="from" id="smtp-from-error" hidden></p></div>
      <div class="panel">
        <div class="field"><label for="test-to">Send a test email to</label>
          <input id="test-to" type="email" autocomplete="email" spellcheck="false"></div>
        <button type="button" id="test-email">Send test email</button>
        <p id="test-email-result" role="status" aria-live="polite"></p>
      </div>
    </div>
    <div id="no-email-warning" class="notice warn" hidden>
      <p><strong>Without email:</strong></p>
      <ul>
        <li>people who forget their password cannot reset it themselves,</li>
        <li>accounts cannot be recovered by email,</li>
        <li>nobody is told when their account is signed in somewhere new,</li>
        <li>email addresses are not confirmed.</li>
      </ul>
      <p>You can add email later by setting the SMTP variables described in the install guide.</p>
    </div>
    <div class="nav"><button type="button" class="back">Back</button><button type="submit" class="primary">Next</button></div>
  </form>
</section>

<section class="step" id="step-4" hidden aria-labelledby="h-4">
  <h2 id="h-4" tabindex="-1">Your admin account</h2>
  <p>This is the account you use to run the server. It has every admin permission: approving people, managing communities, and moderation.</p>
  <form data-section="admin" novalidate>
    <div class="field"><label for="admin-handle">Name</label>
      <p class="hint" id="admin-handle-hint">Lowercase letters, digits and dashes, for example <code>admin</code> or <code>maria</code>. You sign in with it.</p>
      <input id="admin-handle" name="handle" autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="admin-handle-hint admin-handle-error">
      <p class="error" data-error="handle" id="admin-handle-error" hidden></p></div>
    <div class="field"><label for="admin-email">Email</label>
      <input id="admin-email" name="email" type="email" autocomplete="email" spellcheck="false" aria-describedby="admin-email-error">
      <p class="error" data-error="email" id="admin-email-error" hidden></p></div>
    <div class="field"><label for="admin-password">Password</label>
      <p class="hint" id="admin-password-hint">At least 10 characters, using at least three of: lowercase letters, capitals, digits, symbols. A password manager can make one for you.</p>
      <input id="admin-password" name="password" type="password" autocomplete="new-password" aria-describedby="admin-password-hint admin-password-error">
      <p class="error" data-error="password" id="admin-password-error" hidden></p></div>
    <div class="field"><label for="admin-repeat">Type the password again</label>
      <input id="admin-repeat" name="repeat" type="password" autocomplete="new-password" aria-describedby="admin-repeat-error">
      <p class="error" data-error="repeat" id="admin-repeat-error" hidden></p></div>
    <p class="hint">The password is kept only in scrambled form (a hash) in the database. It is never written into the settings file.</p>
    <div class="nav"><button type="button" class="back">Back</button><button type="submit" class="primary">Next</button></div>
  </form>
</section>

<section class="step" id="step-5" hidden aria-labelledby="h-5">
  <h2 id="h-5" tabindex="-1">Options</h2>
  <form data-section="options" novalidate>
    <p class="hint">These are starting choices. You can change them at any time, without a restart, in the dashboard under Admin, Server settings.</p>
    <label class="choice compact"><input type="checkbox" name="inviteOnly">
      <span><strong>Invite-only sign-up</strong><span class="hint">New people need an invite code from an admin. Recommended until you are ready to open up.</span></span></label>
    <label class="choice compact"><input type="checkbox" name="pseudonyms">
      <span><strong>Allow pseudonyms</strong><span class="hint">Anonymous accounts that are not linked to anyone's main account, not even on this server. Useful for sources and whistle-blowers.</span></span></label>
    <fieldset class="field">
      <legend><strong>Who looks after people's keys?</strong></legend>
      <p class="hint">Every account has a secret key that proves it belongs to its owner. Choose the ways you allow; people pick one when they sign up.</p>
      <label class="choice compact"><input type="checkbox" name="custody" value="custodial">
        <span><strong>The server keeps it</strong> (easiest)<span class="hint">People just use a password, and can recover the account by email if they forget it.</span></span></label>
      <label class="choice compact"><input type="checkbox" name="custody" value="assisted">
        <span><strong>Shared</strong><span class="hint">The person keeps a key and the server keeps a backup. The person can undo anything the server does with it within 72 hours.</span></span></label>
      <label class="choice compact"><input type="checkbox" name="custody" value="self">
        <span><strong>The person keeps it alone</strong> (most private)<span class="hint">Nobody, not even you, can take over the account. If they lose their key and backup phrase, the account is lost.</span></span></label>
      <p class="error" data-error="custody" hidden></p>
      <div class="field"><label for="custodyDefault">Offer first</label>
        <select id="custodyDefault" name="custodyDefault">
          <option value="custodial">The server keeps it</option>
          <option value="assisted">Shared</option>
          <option value="self">The person keeps it alone</option>
        </select>
        <p class="error" data-error="custodyDefault" hidden></p></div>
    </fieldset>
    <label class="choice compact disabled"><input type="checkbox" name="deviceSigning" disabled>
      <span><strong>Device signing</strong> (coming soon)<span class="hint">Lets people approve important actions on their own phone or computer instead of trusting the server. It is being built; you will be able to turn it on later.</span></span></label>
    <div class="nav"><button type="button" class="back">Back</button><button type="submit" class="primary">Next</button></div>
  </form>
</section>

<section class="step" id="step-6" hidden aria-labelledby="h-6">
  <h2 id="h-6" tabindex="-1">Review and finish</h2>
  <p>Check your choices. Use <em>Change</em> to go back to a step.</p>
  <div id="review"></div>
  <div id="review-notices"></div>
  <form id="finish-form" novalidate>
    <p class="error" id="finish-error" role="alert" hidden></p>
    <div class="nav"><button type="button" class="back">Back</button><button type="submit" class="primary" id="finish-button">Finish setup</button></div>
  </form>
</section>
</div>

<section class="step" id="step-done" hidden aria-labelledby="h-done">
  <h2 id="h-done" tabindex="-1">Setup is finished</h2>
  <div class="notice warn">
    <p><strong>Download your settings file now.</strong> It holds your server's secret keys. Keep it somewhere private, such as a password manager. If the server's disk is ever lost, this file is the only way to unlock the keys stored in your database. Anyone who has it can act as your server, so never share it.</p>
    <p><button type="button" id="download-settings" class="primary">Download settings file</button></p>
  </div>
  <p id="restart-status" role="status" aria-live="polite">The server is restarting with your settings…</p>
  <div id="done-links"></div>
  <h3>Still to do</h3>
  <div id="done-dns"></div>
  <ol id="done-checklist" class="checklist"></ol>
</section>
</main>
<script src="/setup/assets/setup.js"></script>
</body>
</html>`;
}

export const SETUP_CSS = `:root{--bg:#fff;--fg:#1d1d1f;--muted:#55575c;--line:#c9ccd1;--accent:#1f5fbf;--accent-fg:#fff;--bad:#b3261e;--good:#146c2e;--warn-bg:#fff6e0;--warn-line:#c78a00;--panel:#f4f5f7;--focus:#ffbf47}
@media (prefers-color-scheme:dark){:root{--bg:#141517;--fg:#ececee;--muted:#b4b7bd;--line:#3d4046;--accent:#7fb0ff;--accent-fg:#0b1a33;--bad:#ff8a80;--good:#7ed69a;--warn-bg:#2d2412;--warn-line:#d9a521;--panel:#1d1f22}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.skip{position:absolute;left:-999px}.skip:focus{left:1rem;top:1rem;background:var(--bg);padding:.5rem;z-index:2}
.top,main{max-width:42rem;margin:0 auto;padding:0 1rem}
.top{padding-top:1.5rem}.brand{margin:0;color:var(--muted);font-weight:600;letter-spacing:.02em}
h1{margin:.2rem 0 1rem;font-size:1.6rem}h2{font-size:1.35rem;margin:1rem 0 .5rem}h3{font-size:1.1rem;margin:1.5rem 0 .5rem}
h2:focus{outline:none}
p{margin:.5rem 0}a{color:var(--accent)}code{font-size:.92em;background:var(--panel);padding:.05rem .3rem;border-radius:4px;overflow-wrap:anywhere}
.hint{color:var(--muted);font-size:.93rem;display:block}
.optional{color:var(--muted);font-weight:400}
.field{margin:1.1rem 0}
label{font-weight:600}
input:not([type=radio]):not([type=checkbox]),select{display:block;width:100%;margin-top:.35rem;padding:.65rem .75rem;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:6px;min-height:44px}
input[aria-invalid=true]{border-color:var(--bad);border-width:2px}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
fieldset{border:0;padding:0;margin:0}legend{padding:0;margin-bottom:.4rem}
.choice{display:flex;gap:.75rem;align-items:flex-start;border:1px solid var(--line);border-radius:8px;padding:.85rem;margin:.6rem 0;font-weight:400;cursor:pointer}
.choice input{margin-top:.3rem;width:1.15rem;height:1.15rem;flex:none}
.choice.compact{padding:.65rem .85rem}
.choice:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.choice.disabled{opacity:.7;cursor:not-allowed}
.row{display:flex;gap:1rem;flex-wrap:wrap}.row>.field{flex:1 1 10rem}
button{font:inherit;min-height:44px;padding:.6rem 1.1rem;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}
button:disabled{opacity:.6;cursor:progress}
.nav{display:flex;justify-content:space-between;gap:1rem;margin:2rem 0 3rem}
.error{color:var(--bad);font-weight:600;margin:.35rem 0 0}
.good{color:var(--good);font-weight:600}.bad{color:var(--bad);font-weight:600}
.notice{border-left:4px solid var(--line);background:var(--panel);padding:.75rem 1rem;border-radius:4px;margin:1rem 0}
.notice.warn{border-color:var(--warn-line);background:var(--warn-bg)}
.notice.bad{border-color:var(--bad)}
.panel{background:var(--panel);border-radius:8px;padding:1rem;margin:1.5rem 0}
.panel h3{margin-top:0}
.progress{list-style:none;display:flex;gap:.25rem;padding:0;margin:0 0 1rem;flex-wrap:wrap}
.progress li{display:flex;align-items:center;gap:.35rem;font-size:.85rem;color:var(--muted);padding:.2rem .5rem .2rem .2rem;border-radius:99px}
.progress .num{display:inline-grid;place-items:center;width:1.6rem;height:1.6rem;border-radius:50%;border:1px solid var(--line);font-weight:600}
.progress li[aria-current=step]{color:var(--fg);font-weight:600}
.progress li[aria-current=step] .num{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.progress li.done .num{border-color:var(--good);color:var(--good)}
@media (max-width:34rem){.progress .label{display:none}.progress li[aria-current=step] .label{display:inline}}
.record{border:1px solid var(--line);border-radius:8px;padding:.75rem;margin:.75rem 0;background:var(--bg)}
.record dl{display:grid;grid-template-columns:auto 1fr auto;gap:.35rem .75rem;align-items:center;margin:.5rem 0}
.record dt{color:var(--muted);font-size:.9rem}.record dd{margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all}
.record button{min-height:36px;padding:.3rem .7rem;font-size:.9rem}
.checks{list-style:none;padding:0}.checks li{margin:.5rem 0}
.review{border-top:1px solid var(--line)}
.review section{border-bottom:1px solid var(--line);padding:.6rem 0}
.review h3{display:flex;justify-content:space-between;align-items:center;margin:.3rem 0;font-size:1rem}
.review dl{margin:0}.review dt{color:var(--muted);font-size:.9rem;margin-top:.4rem}.review dd{margin:0;word-break:break-word}
.checklist li{margin:.6rem 0}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;
