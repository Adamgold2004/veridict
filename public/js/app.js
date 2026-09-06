/* Shared helpers used by every page. */

const api = {
  async req(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new Error(data.error || 'The server could not complete that.');
    return data;
  },
  get:  (p)    => api.req('GET', p),
  post: (p, b) => api.req('POST', p, b),
  put:  (p, b) => api.req('PUT', p, b),
  del:  (p)    => api.req('DELETE', p),
};

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const qs = k => new URLSearchParams(location.search).get(k);

const mmss = s => {
  const neg = s < 0, a = Math.abs(Math.round(s));
  return (neg ? '+' : '') + Math.floor(a / 60) + ':' + String(a % 60).padStart(2, '0');
};

/** Renders the masthead and returns the signed-in user, or null. */
async function mountNav(current) {
  let user = null;
  try { user = (await api.get('/auth/me')).user; } catch { /* signed out */ }

  const links = user
    ? [['/app', 'Tournaments'],
       ...(user.role === 'admin' ? [['/tab', 'Tab room'], ['/consent', 'Consent']] : []),
       ...(user.role === 'debater' ? [['/me', 'My speeches']] : [])]
    : [];

  const el = $('#masthead');
  if (!el) return user;

  el.innerHTML = `
    <a class="wordmark" href="${user ? '/app' : '/'}">
      <span class="seal">V</span> Veridict
    </a>
    <nav class="navlinks">
      ${links.map(([h, t]) =>
        `<a href="${h}"${h === current ? ' aria-current="page"' : ''}>${t}</a>`).join('')}
      ${user
        ? `<span class="whoami">${esc(user.display_name)} · ${esc(user.role)}</span>
           <button class="btn ghost small" id="signout">Sign out</button>`
        : `<a href="/login">Sign in</a>`}
    </nav>`;

  $('#signout')?.addEventListener('click', async () => {
    await api.post('/auth/logout');
    location.href = '/login';
  });

  return user;
}

/** Sends the visitor to sign-in if they aren't allowed on this page. */
async function requireUser(roles) {
  let user = null;
  try { user = (await api.get('/auth/me')).user; } catch { /* signed out */ }
  if (!user) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); return null; }
  if (roles && !roles.includes(user.role)) { location.href = '/app'; return null; }
  return user;
}

function showError(msg, target = '#error') {
  const el = $(target);
  if (!el) return alert(msg);
  el.textContent = msg;
  el.className = 'notice';
  el.hidden = false;
}
function showOk(msg, target = '#error') {
  const el = $(target);
  if (!el) return;
  el.textContent = msg;
  el.className = 'notice ok';
  el.hidden = false;
}
function clearError(target = '#error') {
  const el = $(target);
  if (el) el.hidden = true;
}
