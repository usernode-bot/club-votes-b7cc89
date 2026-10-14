// Club Votes — the board. Renders the decisions the API returns into the
// markup the spec's screen drew (public/screens.css styles it), and wires
// every action on it.
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var TOKEN = params.get('token');
  var DEMO = params.get('demo') === '1';

  var state = {
    signed_in: false,
    viewer_id: null,
    decisions: [],
    comments: {},   // decision id -> [comment]
    openThreads: new Set(),
    reported: new Set(), // "decision:<id>" / "comment:<id>"
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ago(iso) {
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? ' minute' : ' minutes') + ' ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + (h === 1 ? ' hour' : ' hours') + ' ago';
    if (h < 48) return 'yesterday';
    var d = Math.round(h / 24);
    if (d < 14) return d + (d === 1 ? ' day' : ' days') + ' ago';
    var w = Math.round(d / 7);
    return w + (w === 1 ? ' week' : ' weeks') + ' ago';
  }

  // Chalk tally marks: groups of five, four upright strokes crossed by a
  // fifth, one group per five votes.
  function tallySvg(n) {
    if (n <= 0) return '';
    var parts = [], groups = Math.floor(n / 5), rem = n % 5, maxX = 0, g, i, o;
    for (g = 0; g < groups; g++) {
      o = g * 32;
      for (i = 0; i < 4; i++) parts.push('M' + (4 + o + i * 6) + ' 3v16');
      parts.push('M' + (1 + o) + ' 16L' + (26 + o) + ' 5');
      maxX = 26 + o;
    }
    o = groups * 32;
    for (i = 0; i < rem; i++) {
      parts.push('M' + (4 + o + i * 6) + ' 3v16');
      maxX = Math.max(maxX, 4 + o + i * 6);
    }
    var w = maxX + 4;
    return '<svg width="' + w + '" height="22" viewBox="0 0 ' + w + ' 22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="' + parts.join('') + '"/></svg>';
  }

  var ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
  var ICON_BUBBLE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>';
  var ICON_ROSETTE = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="9" r="6"/><path d="M8.5 13.5L7 22l5-3 5 3-1.5-8.5"/></svg>';

  function api(path, options) {
    options = options || {};
    var headers = {};
    if (TOKEN) headers['x-usernode-token'] = TOKEN;
    if (window.usernode && typeof window.usernode.now === 'function') {
      headers['x-usernode-now'] = window.usernode.now();
    }
    if (options.body) headers['Content-Type'] = 'application/json';
    var url = path;
    if (DEMO) url += (url.indexOf('?') === -1 ? '?' : '&') + 'demo=1';
    return fetch(url, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (res) {
      return res.json().then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      }, function () {
        return { ok: res.ok, status: res.status, data: {} };
      });
    });
  }

  function getDecision(id) {
    for (var i = 0; i < state.decisions.length; i++) {
      if (state.decisions[i].id === id) return state.decisions[i];
    }
    return null;
  }

  function replaceDecision(d) {
    for (var i = 0; i < state.decisions.length; i++) {
      if (state.decisions[i].id === d.id) { state.decisions[i] = d; return; }
    }
    state.decisions.push(d);
  }

  function resultLine(r) {
    if (!r) return '';
    if (r.kind === 'none') return 'Nobody voted.';
    if (r.kind === 'tie') {
      var n = r.labels.length;
      return esc(r.labels.slice(0, n - 1).join(', ')) +
        (n > 1 ? ' and ' : '') + esc(r.labels[n - 1]) + ' tied, ' + r.count + ' vote' + (r.count === 1 ? '' : 's') + ' each.';
    }
    return esc(r.label) + ', ' + r.top + ' vote' + (r.top === 1 ? '' : 's') + ' to ' + r.second + '.';
  }

  function reportButton(kind, id) {
    var key = kind + ':' + id;
    if (state.reported.has(key)) {
      return '<button class="quiet" type="button" disabled>Reported</button>';
    }
    return '<button class="quiet" type="button" data-action="report" data-kind="' + kind + '" data-target="' + esc(id) + '">Report</button>';
  }

  function commentCount(d) {
    var cached = state.comments[d.id];
    return cached ? cached.length : d.comment_count;
  }

  function threadHtml(d) {
    var list = state.comments[d.id] || [];
    var out = '<div class="thread">';
    if (!list.length) {
      out += '<p class="hint">No comments yet.</p>';
    }
    list.forEach(function (c) {
      var mine = state.viewer_id != null && String(c.author_id) === String(state.viewer_id);
      out += '<div class="c">' +
        '<div class="by"><span class="text-small"><b>' + (mine ? 'You' : esc(c.author_name)) + '</b> <span class="muted">' + ago(c.created_at) + '</span></span>' +
        (mine
          ? '<button class="quiet" type="button" data-action="delete-comment" data-id="' + esc(c.id) + '">Delete</button>'
          : (state.signed_in ? reportButton('comment', c.id) : '')) +
        '</div>' +
        '<p class="text-body">' + esc(c.body) + '</p></div>';
    });
    if (state.signed_in) {
      out += '<div class="say"><input class="field" maxlength="500" placeholder="Add a comment" data-comment-input>' +
        '<button class="btn-secondary" type="button" data-action="send" data-id="' + esc(d.id) + '">Send</button></div>';
    } else {
      out += '<p class="hint">Sign in to Homeroom to comment.</p>';
    }
    return out + '</div>';
  }

  function cardHtml(d) {
    var closed = !!d.closed_at;
    var canVote = !closed && state.signed_in;
    var html = '<article class="card' + (closed ? ' closed' : '') + '" data-id="' + esc(d.id) + '">';

    html += '<div class="by"><span class="text-small muted">' +
      (d.is_mine ? 'You asked' : esc(d.author_name) + ' asked') + ', ' + ago(d.created_at) + '</span>';
    if (d.is_mine) {
      html += '<span class="text-small muted">' + d.voters + ' vote' + (d.voters === 1 ? '' : 's') + '</span>';
    } else if (state.signed_in) {
      html += reportButton('decision', d.id);
    }
    html += '</div>';

    html += '<h2 class="text-heading">' + esc(d.question) + '</h2>';

    if (closed) {
      html += '<div class="decided">' + ICON_ROSETTE + '<div><p class="lbl text-small">Decided</p><p class="text-body">' + resultLine(d.result) + '</p></div></div>';
    }

    html += '<div class="opts">';
    d.choices.forEach(function (c) {
      var mine = d.my_choice_id === c.id;
      var open = '<' + (canVote ? 'button type="button" data-action="vote"' : 'div') + ' class="opt' + (mine ? ' mine' : '') + '" data-choice="' + esc(c.id) + '">';
      html += open;
      if (!closed) {
        html += '<span class="vote-ring">' + (mine ? ICON_CHECK : '') + '</span>';
      }
      html += '<span class="name text-body">' + esc(c.label) + '</span>';
      if (d.show_counts) {
        html += '<span class="tally">' + tallySvg(c.count) + '<span class="count">' + c.count + '</span></span>';
      }
      html += canVote ? '</button>' : '</div>';
    });
    html += '</div>';

    if (!closed && !d.show_counts) {
      html += '<p class="hint">' +
        (state.signed_in
          ? (d.voters === 0 ? 'Be the first to vote.' : 'Vote to see how the club is leaning. ' + d.voters + ' have voted.')
          : 'Sign in to Homeroom to vote. ' + d.voters + ' have voted so far.') +
        '</p>';
    }

    var count = commentCount(d);
    html += '<div class="foot"><button class="quiet" type="button" data-action="toggle-comments" data-id="' + esc(d.id) + '">' + ICON_BUBBLE + ' ' + count + ' comment' + (count === 1 ? '' : 's') + '</button>';
    if (d.is_mine && !closed) {
      html += '<span class="grow"></span><button class="btn-secondary text-small" type="button" data-action="close" data-id="' + esc(d.id) + '">Close vote</button>' +
        '<button class="quiet" type="button" data-action="delete-decision" data-id="' + esc(d.id) + '">Delete</button>';
    }
    html += '</div>';

    if (state.openThreads.has(d.id)) html += threadHtml(d);
    return html + '</article>';
  }

  function show(el, on) { if (el) el.hidden = !on; }

  function renderAll() {
    var open = [], closedArr = [];
    state.decisions.forEach(function (d) { (d.closed_at ? closedArr : open).push(d); });

    var board = $('board');
    var loading = $('loading'), empty = $('empty'), error = $('error');
    var openLabel = $('open-label'), closedLabel = $('closed-label');
    var openList = $('open-list'), closedList = $('closed-list');
    var askBtn = $('ask-btn'), demoNote = $('demo-note');
    if (!board) return;

    show(demoNote, DEMO && open.length + closedArr.length > 0);
    show(loading, false); show(error, false); show(empty, false);
    var any = open.length + closedArr.length > 0;
    show(openLabel, open.length > 0);
    show(openList, open.length > 0);
    show(closedLabel, closedArr.length > 0);
    show(closedList, closedArr.length > 0);
    openList.innerHTML = open.map(cardHtml).join('');
    closedList.innerHTML = closedArr.map(cardHtml).join('');
    show(askBtn, any && state.signed_in);
  }

  function renderStates(mode, message) {
    // One of loading | empty | error | list.
    var loading = $('loading'), empty = $('empty'), error = $('error');
    var openLabel = $('open-label'), closedLabel = $('closed-label');
    var openList = $('open-list'), closedList = $('closed-list');
    var askBtn = $('ask-btn'), demoNote = $('demo-note');
    show(loading, mode === 'loading');
    show(error, mode === 'error');
    show(empty, mode === 'empty');
    var listing = mode === 'list';
    show(openLabel, listing); show(openList, listing);
    show(closedLabel, listing); show(closedList, listing);
    show(askBtn, false);
    show(demoNote, false);
    if (mode === 'error') {
      // Fixed copy, never the server's own text: what failed, that nothing
      // is lost, and that Retry is there.
      var box = error.querySelector('p.text-body');
      if (box) box.textContent = 'Nothing you posted is lost. Check your connection and try again.';
    }
  }

  function load() {
    renderStates('loading');
    return api('/api/decisions').then(function (r) {
      if (!r.ok) { renderStates('error'); return; }
      state.signed_in = !!r.data.signed_in;
      state.viewer_id = r.data.viewer_id || null;
      state.decisions = r.data.decisions || [];
      if (state.decisions.length === 0) {
        renderStates('empty');
        show($('empty-ask'), state.signed_in);
        show($('empty-guest'), !state.signed_in);
        return;
      }
      renderStates('list');
      renderAll();
    }, function () {
      renderStates('error');
    }).catch(function () {
      renderStates('error');
    });
  }

  function handleGuest(r) {
    if (r.status === 401) { state.signed_in = false; renderAll(); return true; }
    return false;
  }

  function onVote(decisionId, choiceId) {
    api('/api/decisions/' + encodeURIComponent(decisionId) + '/vote', { method: 'POST', body: { choice_id: choiceId } })
      .then(function (r) {
        if (handleGuest(r)) return;
        if (!r.ok) { window.alert(r.data.error || 'The vote could not be saved.'); return; }
        replaceDecision(r.data);
        renderAll();
      });
  }

  function onClose(decisionId) {
    api('/api/decisions/' + encodeURIComponent(decisionId) + '/close', { method: 'POST' })
      .then(function (r) {
        if (!r.ok) { window.alert(r.data.error || 'The vote could not be closed.'); return; }
        replaceDecision(r.data);
        renderAll();
      });
  }

  function onDeleteDecision(decisionId) {
    api('/api/decisions/' + encodeURIComponent(decisionId), { method: 'DELETE' })
      .then(function (r) {
        if (!r.ok) { window.alert(r.data.error || 'The question could not be deleted.'); return; }
        load();
      });
  }

  function onToggleComments(decisionId) {
    if (state.openThreads.has(decisionId)) {
      state.openThreads.delete(decisionId);
      renderAll();
      return;
    }
    state.openThreads.add(decisionId);
    renderAll(); // show the thread (with its input) at once
    if (state.comments[decisionId]) { renderAll(); return; }
    api('/api/decisions/' + encodeURIComponent(decisionId) + '/comments').then(function (r) {
      state.comments[decisionId] = r.ok ? (r.data.comments || []) : [];
      if (!r.ok) { window.alert(r.data.error || 'The comments could not be loaded.'); }
      renderAll();
    });
  }

  function onSend(decisionId, input) {
    var body = (input.value || '').trim();
    if (!body) return;
    input.value = '';
    api('/api/decisions/' + encodeURIComponent(decisionId) + '/comments', { method: 'POST', body: { body: body } })
      .then(function (r) {
        if (handleGuest(r)) return;
        if (!r.ok) { window.alert(r.data.error || 'The comment could not be added.'); return; }
        state.comments[decisionId] = (state.comments[decisionId] || []).concat(r.data);
        var d = getDecision(decisionId);
        if (d) d.comment_count = state.comments[decisionId].length;
        renderAll();
      });
  }

  function onDeleteComment(decisionId, commentId) {
    api('/api/comments/' + encodeURIComponent(commentId), { method: 'DELETE' })
      .then(function (r) {
        if (!r.ok) { window.alert(r.data.error || 'The comment could not be deleted.'); return; }
        state.comments[decisionId] = (state.comments[decisionId] || []).filter(function (c) { return c.id !== commentId; });
        var d = getDecision(decisionId);
        if (d) d.comment_count = state.comments[decisionId].length;
        renderAll();
      });
  }

  function onReport(kind, targetId) {
    api('/api/reports', { method: 'POST', body: { target_type: kind, target_id: targetId } })
      .then(function (r) {
        if (!r.ok) { window.alert(r.data.error || 'The report could not be sent.'); return; }
        state.reported.add(kind + ':' + targetId);
        renderAll();
      });
  }

  // ── Ask the club form ──────────────────────────────────────────────────
  var MAX_CHOICES = 8;
  var choiceFields = $('choice-fields');

  function choiceRow(value, n) {
    var row = document.createElement('div');
    row.className = 'frow';
    var input = document.createElement('input');
    input.className = 'field choice-input';
    input.maxLength = 80;
    input.placeholder = 'Choice ' + n;
    input.setAttribute('aria-label', 'Choice ' + n);
    input.value = value || '';
    var rm = document.createElement('button');
    rm.className = 'quiet';
    rm.type = 'button';
    rm.textContent = 'Remove';
    rm.addEventListener('click', function () { row.remove(); syncChoiceRows(); });
    row.appendChild(input);
    row.appendChild(rm);
    return row;
  }

  function syncChoiceRows() {
    var rows = choiceFields.querySelectorAll('.frow');
    rows.forEach(function (row) {
      row.querySelector('.quiet').hidden = rows.length <= 2;
    });
    $('add-choice').hidden = rows.length >= MAX_CHOICES;
  }

  function initForm() {
    choiceFields.appendChild(choiceRow('', 1));
    choiceFields.appendChild(choiceRow('', 2));
    syncChoiceRows();
    $('add-choice').addEventListener('click', function () {
      choiceFields.appendChild(choiceRow('', choiceFields.querySelectorAll('.frow').length + 1));
      syncChoiceRows();
      var rows = choiceFields.querySelectorAll('.choice-input');
      rows[rows.length - 1].focus();
    });
    $('post-btn').addEventListener('click', function () {
      var question = $('q-input').value.trim();
      var choices = [];
      choiceFields.querySelectorAll('.choice-input').forEach(function (i) {
        var v = i.value.trim();
        if (v && choices.indexOf(v) === -1) choices.push(v);
      });
      var err = $('ask-error');
      if (!question) { err.textContent = 'Write the question first.'; err.hidden = false; return; }
      if (choices.length < 2) { err.textContent = 'Give at least two choices to pick between.'; err.hidden = false; return; }
      err.hidden = true;
      api('/api/decisions', { method: 'POST', body: { question: question, choices: choices } })
        .then(function (r) {
          if (handleGuest(r)) return;
          if (!r.ok) { err.textContent = r.data.error || 'The question could not be posted.'; err.hidden = false; return; }
          $('q-input').value = '';
          choiceFields.innerHTML = '';
          choiceFields.appendChild(choiceRow('', 1));
          choiceFields.appendChild(choiceRow('', 2));
          syncChoiceRows();
          closeForm();
          load();
        });
    });
    $('cancel-btn').addEventListener('click', closeForm);
    $('ask-btn').addEventListener('click', openForm);
    $('empty-ask').addEventListener('click', openForm);
    $('retry').addEventListener('click', load);
  }

  function openForm() {
    show($('ask-form'), true);
    show($('ask-error'), false);
    $('q-input').focus();
    $('ask-form').scrollIntoView({ block: 'start' });
  }

  function closeForm() { show($('ask-form'), false); }

  // ── Events ────────────────────────────────────────────────────────────
  $('board').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    var card = e.target.closest('article.card');
    var decisionId = card ? card.getAttribute('data-id') : null;
    switch (btn.getAttribute('data-action')) {
      case 'vote':
        onVote(decisionId, btn.getAttribute('data-choice'));
        break;
      case 'toggle-comments':
        onToggleComments(btn.getAttribute('data-id'));
        break;
      case 'send': {
        var input = card.querySelector('[data-comment-input]');
        if (input) onSend(decisionId, input);
        break;
      }
      case 'delete-comment':
        onDeleteComment(decisionId, btn.getAttribute('data-id'));
        break;
      case 'close':
        onClose(btn.getAttribute('data-id'));
        break;
      case 'delete-decision':
        onDeleteDecision(btn.getAttribute('data-id'));
        break;
      case 'report':
        onReport(btn.getAttribute('data-kind'), btn.getAttribute('data-target'));
        break;
    }
  });
  $('board').addEventListener('keydown', function (e) {
    // Enter in a comment input sends it.
    if (e.key === 'Enter' && e.target.matches('[data-comment-input]')) {
      var card = e.target.closest('article.card');
      var input = e.target;
      var btn = card.querySelector('[data-action="send"]');
      if (input && btn) onSend(card.getAttribute('data-id'), input);
    }
  });

  initForm();
  load();
})();
