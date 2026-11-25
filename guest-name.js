// Session-scoped name for guests and for accounts with no profile name.
// Kept in sessionStorage so it lasts for the tab session and clears on close.
(function () {
  const KEY = 'apex_display_name';
  const PROXY_PREFIX = 'https://apex-proxy.';
  const STOP_WORDS = new Set([
    'and', 'but', 'please', 'thanks', 'thank', 'from', 'in', 'at', 'for', 'the',
    'a', 'an', 'my', 'is', 'when', 'if', 'after', 'before', 'later', 'tomorrow',
    'tonight', 'back', 'once', 'up', 'again', 'now', 'here',
  ]);
  const NAME_CAPTURE = '([A-Za-z][A-Za-z\'\\-]*(?:\\s+[A-Za-z][A-Za-z\'\\-]*){0,2})';
  const PATTERNS = [
    new RegExp('\\bmy name(?:\'s| is| na| be)\\s+' + NAME_CAPTURE, 'i'),
    new RegExp('\\b(?:you can\\s+)?call me\\s+' + NAME_CAPTURE, 'i'),
    new RegExp('\\bna\\s+' + NAME_CAPTURE + '\\s+be my name\\b', 'i'),
  ];

  function tidy(word) {
    return word === word.toLowerCase() ? word.charAt(0).toUpperCase() + word.slice(1) : word;
  }

  // "my name is chidi" -> "Chidi", "call me Drippy Dee please" -> "Drippy Dee"
  function guessName(text) {
    const source = String(text || '');
    for (const pattern of PATTERNS) {
      const match = pattern.exec(source);
      if (!match) continue;
      const kept = [];
      for (const raw of match[1].split(/\s+/)) {
        const word = raw.replace(/[^A-Za-z'\-]/g, '');
        if (!word || STOP_WORDS.has(word.toLowerCase())) break;
        kept.push(tidy(word));
        if (kept.length === 3) break;
      }
      if (kept.length) return kept.join(' ').slice(0, 80);
    }
    return '';
  }

  function cleanName(value) {
    return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function readName() {
    try {
      return cleanName(sessionStorage.getItem(KEY) || '');
    } catch (_) {
      return '';
    }
  }

  function saveName(value) {
    const name = cleanName(value);
    try {
      if (name) sessionStorage.setItem(KEY, name);
      else sessionStorage.removeItem(KEY);
    } catch (_) {}
    renderChip();
    return name;
  }

  function profileName() {
    const user = window.currentUser;
    if (!user || user.isAnonymous) return '';
    return cleanName(user.displayName || '');
  }

  function renderChip() {
    const chip = document.getElementById('apexNameChip');
    if (!chip) return;
    if (profileName()) {
      chip.classList.add('hidden');
      return;
    }
    chip.classList.remove('hidden');
    const name = readName();
    chip.textContent = name ? 'Apex calls you ' + name + ' \u00b7 change' : 'Tell Apex what to call you';
    chip.title = 'Saved for this browser session only';
  }

  function openNamePrompt() {
    let next;
    try {
      next = window.prompt('What should Apex call you this session?', readName());
    } catch (_) {
      next = null;
    }
    if (next !== null && next !== undefined) saveName(next);
  }

  function buildChip() {
    if (document.getElementById('apexNameChip')) return;
    const anchor = document.getElementById('authUserName');
    const holder = anchor && anchor.parentElement;
    if (!holder || !holder.parentElement) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.id = 'apexNameChip';
    chip.className = 'hidden w-full text-left text-[10px] text-slate-400 px-1 truncate hover:text-white transition';
    chip.addEventListener('click', openNamePrompt);
    holder.parentElement.insertBefore(chip, holder.nextSibling);
    renderChip();
    if (anchor) {
      new MutationObserver(renderChip).observe(anchor, { childList: true, characterData: true, subtree: true });
    }
  }

  // Send the session name whenever the app has none to send (guests, anonymous
  // accounts, or profiles without a display name).
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
        const url = request ? request.url : String(input || '');
        const method = String((init && init.method) || (request && request.method) || 'GET').toUpperCase();
        const body = init && typeof init.body === 'string' ? init.body : '';
        if (method === 'POST' && url.indexOf(PROXY_PREFIX) === 0 && body) {
          const data = JSON.parse(body);
          if (data && Array.isArray(data.messages)) {
            let name = readName();
            if (!name) {
              const lastUser = data.messages.slice().reverse().find((m) => m && m.role === 'user');
              const said = lastUser && typeof lastUser.content === 'string' ? guessName(lastUser.content) : '';
              if (said) name = saveName(said);
            }
            if (name && (!data.userName || !String(data.userName).trim())) {
              init = { ...(init || {}), body: JSON.stringify({ ...data, userName: name }) };
            }
          }
        }
      } catch (_) {}
      return originalFetch.call(this, input, init);
    };
  }

  window.getGuestName = readName;
  window.setGuestName = saveName;
  window.__apexGuessName = guessName;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildChip);
  } else {
    buildChip();
  }
})();
