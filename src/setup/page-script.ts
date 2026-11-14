/**
 * The setup wizard's browser script, served as /setup/assets/setup.js.
 * Plain ES2017, no build step. The server checks everything again; checks
 * here only decide which step to show.
 */
export const SETUP_SCRIPT = `(function () {
  'use strict';
  var STORE_KEY = 'of-setup-draft';
  var SECRET_FIELDS = { admin: ['password', 'repeat'], email: ['password'] };
  var SECTION_STEP = { kind: 1, addresses: 2, email: 3, admin: 4, options: 5 };
  var LOOK_NAMES = { openfederation: 'OpenFederation', 'pds-basic': 'PDS Basic', opennewsrooms: 'Open Newsrooms' };
  var status = null;
  var settingsText = null;
  var state = { kind: '', addresses: {}, email: { mode: '' }, admin: {}, options: null, optionsFor: '' };

  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'className') node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  function saveDraft() {
    try {
      var copy = JSON.parse(JSON.stringify(state));
      Object.keys(SECRET_FIELDS).forEach(function (s) { SECRET_FIELDS[s].forEach(function (f) { if (copy[s]) delete copy[s][f]; }); });
      sessionStorage.setItem(STORE_KEY, JSON.stringify(copy));
    } catch (e) { /* storage unavailable: the draft just is not kept */ }
  }
  function loadDraft() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY);
      if (raw) { var d = JSON.parse(raw); if (d && typeof d === 'object') state = Object.assign(state, d); }
    } catch (e) { /* ignore */ }
  }

  function call(method, path, body) {
    return fetch(path, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
    });
  }

  function showOnly(id) {
    ['loading', 'step-locked', 'step-claim', 'step-done'].forEach(function (s) { $(s).hidden = s !== id; });
    $('wizard').hidden = true;
    var node = $(id);
    var h = node && node.querySelector('h2');
    if (h) h.focus();
  }

  var current = 1;
  function showStep(n) {
    current = n;
    ['loading', 'step-locked', 'step-claim', 'step-done'].forEach(function (s) { $(s).hidden = true; });
    $('wizard').hidden = false;
    for (var i = 1; i <= 6; i++) $('step-' + i).hidden = i !== n;
    var items = $('progress').querySelectorAll('li');
    for (var j = 0; j < items.length; j++) {
      var step = Number(items[j].getAttribute('data-step'));
      if (step === n) items[j].setAttribute('aria-current', 'step'); else items[j].removeAttribute('aria-current');
      items[j].classList.toggle('done', step < n);
    }
    if (n === 6) renderReview();
    window.scrollTo(0, 0);
    $('h-' + n).focus();
  }

  function form(section) { return document.querySelector('form[data-section="' + section + '"]'); }

  function clearErrors(f) {
    var errs = f.querySelectorAll('[data-error]');
    for (var i = 0; i < errs.length; i++) { errs[i].hidden = true; errs[i].textContent = ''; }
    var inv = f.querySelectorAll('[aria-invalid]');
    for (var k = 0; k < inv.length; k++) inv[k].removeAttribute('aria-invalid');
  }
  function showErrors(f, errors) {
    clearErrors(f);
    var first = null;
    Object.keys(errors || {}).forEach(function (name) {
      var slot = f.querySelector('[data-error="' + name + '"]');
      if (slot) { slot.textContent = errors[name]; slot.hidden = false; }
      var input = f.querySelector('[name="' + name + '"]');
      if (input) { input.setAttribute('aria-invalid', 'true'); if (!first) first = input; }
      else if (!first && slot) first = slot;
    });
    if (first) {
      if (first.closest && first.closest('details')) first.closest('details').open = true;
      if (first.focus) first.focus();
    }
    return !!first;
  }

  // ---- reading and filling each step's form ----
  function readSection(section) {
    var f = form(section);
    if (section === 'kind') {
      var k = f.querySelector('input[name=kind]:checked');
      state.kind = k ? k.value : '';
      if (state.kind && state.optionsFor !== state.kind) {
        state.options = JSON.parse(JSON.stringify(status.defaults[state.kind]));
        state.optionsFor = state.kind;
      }
    } else if (section === 'addresses') {
      var own = f.querySelector('input[name=plcChoice]:checked');
      state.addresses = {
        publicUrl: f.publicUrl.value.trim(),
        handleDomain: f.handleDomain.value.trim(),
        dashboardUrl: f.dashboardUrl.value.trim(),
        plcUrl: own && own.value === 'own' ? f.plcUrl.value.trim() : '',
        plcChoice: own ? own.value : 'default',
      };
    } else if (section === 'email') {
      var m = f.querySelector('input[name=mode]:checked');
      state.email = m && m.value === 'smtp' ? {
        mode: 'smtp', host: f.host.value.trim(), port: f.port.value.trim(), security: f.security.value,
        user: f.user.value.trim(), password: f.password.value, from: f.from.value.trim(),
      } : { mode: m ? m.value : '' };
    } else if (section === 'admin') {
      state.admin = { handle: f.handle.value.trim().toLowerCase(), email: f.email.value.trim(), password: f.password.value, repeat: f.repeat.value };
    } else if (section === 'options') {
      var custody = [];
      var boxes = f.querySelectorAll('input[name=custody]:checked');
      for (var i = 0; i < boxes.length; i++) custody.push(boxes[i].value);
      var approval = f.querySelector('input[name=accountApproval]:checked');
      var look = f.querySelector('input[name=appearance]:checked');
      state.options = {
        inviteOnly: f.inviteOnly.checked, pseudonyms: f.pseudonyms.checked, custody: custody, custodyDefault: f.custodyDefault.value,
        accountApproval: approval ? approval.value : 'manual', appearance: look ? look.value : 'openfederation',
      };
    }
    saveDraft();
  }

  function fillForms() {
    var f;
    if (state.kind) { f = form('kind'); var r = f.querySelector('input[value="' + state.kind + '"]'); if (r) r.checked = true; }
    f = form('addresses');
    var s = status.suggestions || {};
    f.publicUrl.value = state.addresses.publicUrl || s.publicUrl || '';
    f.handleDomain.value = state.addresses.handleDomain || s.handleDomain || '';
    f.dashboardUrl.value = state.addresses.dashboardUrl !== undefined ? state.addresses.dashboardUrl : (s.dashboardUrl || '');
    var plcOwn = state.addresses.plcChoice === 'own' || (!state.addresses.plcChoice && s.plcUrl && s.plcUrl !== status.defaultPlcUrl);
    f.querySelector('input[name=plcChoice][value="' + (plcOwn ? 'own' : 'default') + '"]').checked = true;
    f.plcUrl.value = state.addresses.plcUrl || (plcOwn ? s.plcUrl : '') || '';
    $('plcUrl-field').hidden = !plcOwn;
    if (plcOwn) $('plc-details').open = true;
    updateDomainSample();

    f = form('email');
    if (state.email.mode) f.querySelector('input[name=mode][value="' + state.email.mode + '"]').checked = true;
    if (state.email.mode === 'smtp') {
      f.host.value = state.email.host || ''; f.port.value = state.email.port || '587';
      f.security.value = state.email.security || 'starttls'; f.user.value = state.email.user || ''; f.from.value = state.email.from || '';
    }
    updateEmailMode();

    f = form('admin');
    f.handle.value = state.admin.handle || ''; f.email.value = state.admin.email || '';
    fillOptions();
  }
  function fillOptions() {
    var f = form('options');
    var o = state.options || (state.kind ? status.defaults[state.kind] : status.defaults.community);
    f.inviteOnly.checked = !!o.inviteOnly; f.pseudonyms.checked = !!o.pseudonyms;
    var boxes = f.querySelectorAll('input[name=custody]');
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = o.custody.indexOf(boxes[i].value) !== -1;
    f.custodyDefault.value = o.custodyDefault;
    // A draft saved by an older page has neither: the defaults.
    var approval = f.querySelector('input[name=accountApproval][value="' + (o.accountApproval === 'automatic' ? 'automatic' : 'manual') + '"]');
    if (approval) approval.checked = true;
    var look = f.querySelector('input[name=appearance][value="' + (LOOK_NAMES[o.appearance] ? o.appearance : 'openfederation') + '"]');
    if (look) look.checked = true;
  }

  function updateDomainSample() {
    var v = form('addresses').handleDomain.value.trim().replace(/^https?:\\/\\//, '').replace(/^[.@]+/, '') || 'example.org';
    var spans = document.querySelectorAll('.domain-sample');
    for (var i = 0; i < spans.length; i++) spans[i].textContent = v;
  }
  function updateEmailMode() {
    var f = form('email');
    var m = f.querySelector('input[name=mode]:checked');
    $('smtp-fields').hidden = !(m && m.value === 'smtp');
    $('no-email-warning').hidden = !(m && m.value === 'none');
    if (!$('test-to').value && state.admin.email) $('test-to').value = state.admin.email;
  }

  // ---- DNS records and live checks ----
  function copyButton(value, label) {
    var b = el('button', { type: 'button', text: 'Copy', 'aria-label': 'Copy ' + label });
    b.addEventListener('click', function () {
      var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(done, function () { b.textContent = 'Select and copy'; });
      else b.textContent = 'Select and copy';
    });
    return b;
  }
  function renderRecords(container, records) {
    if (!records.length) { container.appendChild(el('p', { text: 'No records are needed for these addresses.' })); return; }
    records.forEach(function (r) {
      var dl = el('dl', {}, [
        el('dt', { text: 'Type' }), el('dd', { text: r.type }), el('span'),
        el('dt', { text: 'Name' }), el('dd', { text: r.name }), copyButton(r.name, 'name ' + r.name),
        el('dt', { text: 'Value' }), el('dd', { text: r.value }), copyButton(r.value, 'value for ' + r.name),
      ]);
      container.appendChild(el('div', { className: 'record' }, [
        el('p', {}, [el('strong', { text: r.purpose }), r.required ? '' : ' (optional)']),
        dl,
        r.note ? el('p', { className: 'hint', text: r.note }) : null,
      ]));
    });
  }
  function renderChecks(container, checks) {
    var ul = el('ul', { className: 'checks' });
    checks.forEach(function (c) {
      var mark = c.ok === true ? el('span', { className: 'good', text: 'Working: ' }) : c.ok === false ? el('span', { className: 'bad', text: 'Not yet: ' }) : el('span', { text: 'Skipped: ' });
      ul.appendChild(el('li', {}, [mark, el('strong', { text: c.label }), ' ', c.detail]));
    });
    container.appendChild(ul);
  }

  function pingAddress(a) {
    var label = 'Server address.';
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 5000) : null;
    return fetch(a.url, { mode: 'cors', cache: 'no-store', credentials: 'omit', signal: controller ? controller.signal : undefined })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        var here = body && body.instance === a.instance;
        return { label: label, ok: here, detail: here ? a.origin + ' leads to this server.' : a.origin + ' answers, but it is a different server. Check the record for ' + a.host + '.' };
      }, function () {
        return { label: label, ok: false, detail: a.origin + ' cannot be reached yet. If you just added its record, wait a few minutes and check again.' };
      })
      .then(function (check) { if (timer) clearTimeout(timer); return check; });
  }

  function checkDns() {
    readSection('addresses');
    var out = $('dns-output');
    out.textContent = 'Checking…';
    var button = $('dns-check');
    button.disabled = true;
    call('POST', '/setup/api/check-dns', { addresses: state.addresses }).then(function (r) {
      button.disabled = false;
      out.textContent = '';
      if (r.data.errors) { showErrors(form('addresses'), r.data.errors); out.textContent = 'Fix the addresses above first.'; return; }
      if (!r.ok) { out.textContent = r.data.message || 'The check did not work. Try again.'; return; }
      renderRecords(out, r.data.records);
      var heading = el('h3', { text: 'What we found just now' });
      out.appendChild(heading);
      // This browser asks the address whether it is this server; the server
      // itself never fetches an address typed into the form.
      pingAddress(r.data.addressCheck).then(function (serverCheck) {
        renderChecks(out, [serverCheck].concat(r.data.checks));
        button.textContent = 'Check again';
      });
    }, function () { button.disabled = false; out.textContent = 'Could not reach the server. Try again.'; });
  }

  function testEmail() {
    readSection('email');
    var result = $('test-email-result');
    result.className = '';
    result.textContent = 'Sending…';
    $('test-email').disabled = true;
    call('POST', '/setup/api/test-email', { email: state.email, to: $('test-to').value.trim() }).then(function (r) {
      $('test-email').disabled = false;
      if (r.data.errors) { showErrors(form('email'), r.data.errors); result.textContent = 'Fix the settings above first.'; return; }
      result.className = r.ok ? 'good' : 'bad';
      result.textContent = r.data.message || (r.ok ? 'Sent.' : 'That did not work.');
    }, function () { $('test-email').disabled = false; result.textContent = 'Could not reach the server. Try again.'; });
  }

  // ---- review ----
  var CUSTODY_NAMES = { custodial: 'The server keeps it', assisted: 'Shared', self: 'The person keeps it alone' };
  function renderReview() {
    var box = $('review');
    box.textContent = '';
    var wrap = el('div', { className: 'review' });
    function block(title, step, rows) {
      var change = el('button', { type: 'button', text: 'Change', 'aria-label': 'Change ' + title });
      change.addEventListener('click', function () { showStep(step); });
      var dl = el('dl');
      rows.forEach(function (row) { dl.appendChild(el('dt', { text: row[0] })); dl.appendChild(el('dd', { text: row[1] })); });
      wrap.appendChild(el('section', {}, [el('h3', {}, [title, change]), dl]));
    }
    var a = state.addresses, e = state.email, o = state.options || {};
    var domain = (a.handleDomain || '').replace(/^https?:\\/\\//, '').replace(/^[.@]+/, '');
    block('Kind of server', 1, [['Kind', state.kind === 'privacy' ? 'A newsroom or privacy-first server' : 'A community or club server']]);
    block('Addresses', 2, [
      ['Server address', a.publicUrl], ['Names look like', 'alice.' + domain],
      ['Dashboard', a.dashboardUrl || 'Not used'], ['Identity directory', a.plcUrl || status.defaultPlcUrl],
    ]);
    block('Email', 3, e.mode === 'smtp'
      ? [['Sent through', e.host + ' (port ' + e.port + ')'], ['Sent from', e.from]]
      : [['Email', 'No email for now']]);
    block('Admin account', 4, [['Name', state.admin.handle], ['Email', state.admin.email], ['Password', 'Set (not shown)']]);
    block('Options', 5, [
      ['Sign-up', o.inviteOnly ? 'Invite only' : 'Open to anyone'],
      ['Pseudonyms', o.pseudonyms ? 'Allowed' : 'Not allowed'],
      ['Keys', (o.custody || []).map(function (m) { return CUSTODY_NAMES[m]; }).join(', ')],
      ['Offered first', CUSTODY_NAMES[o.custodyDefault] || ''],
      ['New accounts', o.accountApproval === 'automatic' ? 'Approved automatically' : 'Approved by an admin'],
      ['Dashboard look', LOOK_NAMES[o.appearance] || LOOK_NAMES.openfederation],
    ]);
    box.appendChild(wrap);

    var notices = $('review-notices');
    notices.textContent = '';
    notices.appendChild(el('p', { className: 'hint' }, ['Secret keys are created for you when you finish. Your settings are saved on this server\\'s disk at ', el('code', { text: status.configPath }), '.']));
    (status.warnings || []).forEach(function (w) { notices.appendChild(el('div', { className: 'notice warn' }, [el('p', { text: w })])); });
    if (status.overridden && status.overridden.length) {
      notices.appendChild(el('div', { className: 'notice' }, [el('p', { text: 'These settings are already set by your hosting environment, and those values will be used instead of the ones chosen here: ' + status.overridden.join(', ') + '.' })]));
    }
  }

  function finish(event) {
    event.preventDefault();
    var button = $('finish-button');
    var err = $('finish-error');
    err.hidden = true;
    button.disabled = true;
    button.textContent = 'Finishing…';
    call('POST', '/setup/api/finish', { input: state }).then(function (r) {
      button.disabled = false;
      button.textContent = 'Finish setup';
      if (r.data.errors) {
        var sections = Object.keys(r.data.errors);
        var first = sections.sort(function (x, y) { return SECTION_STEP[x] - SECTION_STEP[y]; })[0];
        showStep(SECTION_STEP[first]);
        showErrors(form(first), r.data.errors[first]);
        return;
      }
      if (!r.ok) { err.textContent = r.data.message || 'Setup could not be finished. Try again.'; err.hidden = false; return; }
      done(r.data);
    }, function () {
      button.disabled = false;
      button.textContent = 'Finish setup';
      err.textContent = 'Could not reach the server. Check your connection and try again.';
      err.hidden = false;
    });
  }

  function done(result) {
    settingsText = result.settingsFile;
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
    showOnly('step-done');
    var dns = $('done-dns');
    dns.textContent = '';
    if (result.records && result.records.length) {
      dns.appendChild(el('p', { text: 'Add these records where you manage your domain, if you have not already:' }));
      renderRecords(dns, result.records);
    }
    var list = $('done-checklist');
    list.textContent = '';
    (result.checklist || []).forEach(function (item) {
      list.appendChild(el('li', {}, [el('strong', { text: item.title }), el('br'), item.detail]));
    });
    waitForRestart(result);
  }

  function waitForRestart(result) {
    var tries = 0;
    var line = $('restart-status');
    function poll() {
      tries++;
      fetch('/health', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (h) {
        if (h && h.status && h.status !== 'setup') {
          line.textContent = 'Your server is running with the new settings.';
          var links = $('done-links');
          links.textContent = '';
          if (result.dashboardUrl) links.appendChild(el('p', {}, ['Next: ', el('a', { href: result.dashboardUrl, text: 'open the dashboard' }), ' and sign in as ' + result.adminHandle + '.']));
          else links.appendChild(el('p', { text: 'Next: sign in as ' + result.adminHandle + ' with the app or dashboard you use.' }));
          return;
        }
        later();
      }).catch(later);
    }
    function later() {
      if (tries > 60) { line.textContent = 'The server has not come back yet. If it does not within a few minutes, restart it from your hosting dashboard and check its log.'; return; }
      setTimeout(poll, 2000);
    }
    setTimeout(poll, 1500);
  }

  function download() {
    if (!settingsText) return;
    var blob = new Blob([settingsText], { type: 'text/plain' });
    var a = el('a', { href: URL.createObjectURL(blob), download: 'openfederation.env' });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---- wiring ----
  function wire() {
    $('claim-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var input = $('claim-code');
      var error = $('claim-code-error');
      error.hidden = true;
      input.removeAttribute('aria-invalid');
      call('POST', '/setup/api/claim', { code: input.value }).then(function (r) {
        if (r.ok) { start(); return; }
        error.textContent = r.data.message || 'That code is not right.';
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }, function () { error.textContent = 'Could not reach the server. Try again.'; error.hidden = false; });
    });

    var forms = document.querySelectorAll('form[data-section]');
    for (var i = 0; i < forms.length; i++) {
      (function (f) {
        var section = f.getAttribute('data-section');
        f.addEventListener('submit', function (event) {
          event.preventDefault();
          readSection(section);
          if (section === 'kind') fillOptions();
          call('POST', '/setup/api/validate', { section: section, input: state }).then(function (r) {
            if (r.status === 401) { showOnly('step-claim'); return; }
            if (showErrors(f, r.data.errors)) return;
            showStep(SECTION_STEP[section] + 1);
          }, function () { showErrors(f, {}); alert('Could not reach the server. Try again.'); });
        });
      })(forms[i]);
    }
    var backs = document.querySelectorAll('button.back');
    for (var j = 0; j < backs.length; j++) backs[j].addEventListener('click', function () { showStep(Math.max(1, current - 1)); });

    form('addresses').handleDomain.addEventListener('input', updateDomainSample);
    var plc = form('addresses').querySelectorAll('input[name=plcChoice]');
    for (var p = 0; p < plc.length; p++) plc[p].addEventListener('change', function (e) { $('plcUrl-field').hidden = e.target.value !== 'own'; });
    var modes = form('email').querySelectorAll('input[name=mode]');
    for (var m = 0; m < modes.length; m++) modes[m].addEventListener('change', updateEmailMode);
    form('email').port.addEventListener('change', function (e) {
      var sec = form('email').security;
      if (e.target.value.trim() === '465') sec.value = 'tls'; else if (e.target.value.trim() === '587') sec.value = 'starttls';
    });
    $('dns-check').addEventListener('click', checkDns);
    $('test-email').addEventListener('click', testEmail);
    $('finish-form').addEventListener('submit', finish);
    $('download-settings').addEventListener('click', download);
  }

  function start() {
    call('GET', '/setup/api/status').then(function (r) {
      status = r.data;
      if (status.locked) { $('locked-path').textContent = status.configPath || 'the path in OPENFEDERATION_CONFIG_FILE'; showOnly('step-locked'); return; }
      if (!status.claimed) { showOnly('step-claim'); return; }
      loadDraft();
      fillForms();
      showStep(1);
    }, function () { $('loading').textContent = 'Could not reach the server. Reload the page to try again.'; });
  }

  wire();
  start();
})();
`;
