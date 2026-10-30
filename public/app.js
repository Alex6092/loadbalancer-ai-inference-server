const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const fmt = (v) => new Intl.NumberFormat('fr-FR').format(v || 0);
const date = (v) =>
  v ? new Date(v).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const labels = {
  available: 'Disponible',
  unavailable: 'Indisponible',
  checking: 'Vérification',
  queued: 'En attente',
  running: 'En cours',
  succeeded: 'Terminé',
  failed: 'Échec',
  cancelled: 'Annulé',
  expired: 'Expiré',
  pending: 'En attente',
  delivered: 'Livré',
  uncertain: 'À vérifier',
  disabled: 'Désactivé',
  maintenance: 'Maintenance',
};
const badge = (s) => `<span class="badge ${esc(s)}">${esc(labels[s] || s)}</span>`;
const split = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
let csrf,
  snapshot,
  events,
  refreshing = false,
  page = 'overview',
  users = [],
  userApp = '',
  offset = 0,
  accounts = [],
  usage = null,
  usageQuery = {};
let queueQuery = {},
  queueOffset = 0,
  queueData = { data: [], total: 0 };
async function api(path, method = 'GET', body) {
  const response = await fetch(`/admin/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') showLogin();
    throw new Error(result.error?.message || 'La demande a échoué.');
  }
  return result;
}
let toastTimer;
function toast(message, failure = false) {
  $('#toast').textContent = message;
  $('#toast').className = failure ? 'failure' : '';
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 6000);
}
function showLogin() {
  events?.close();
  $('#shell').hidden = true;
  $('#login').hidden = false;
}
async function showShell(account) {
  csrf = account.csrf;
  $('#account-name').textContent = account.username;
  $('#login').hidden = true;
  $('#shell').hidden = false;
  await refresh();
  events?.close();
  events = new EventSource('/admin/api/events');
  events.onmessage = () => {
    $('#live-status').textContent = '● Actualisation en direct';
    $('#live-status').className = 'live';
    void refresh();
  };
  events.onerror = () => {
    $('#live-status').textContent = '● Reconnexion en cours';
    $('#live-status').className = 'live offline';
  };
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    snapshot = await api('/snapshot');
    $('#last-refresh').textContent = `À JOUR · ${new Date().toLocaleTimeString('fr-FR')}`;
    if (page === 'queue') {
      if (!document.activeElement?.closest('#queue-form')) await loadJobs();
    } else if (!$('#usage-form') && !$('#user-app')) render();
  } catch (e) {
    toast(e.message, true);
  } finally {
    refreshing = false;
  }
}
const button = (action, id, label, cls = '') =>
  `<button class="${cls}" data-action="${action}" data-id="${esc(id)}">${label}</button>`;
const heading = (title, subtitle, actions = '') =>
  `<div class="page-heading"><div><h1>${title}</h1><p class="muted">${subtitle}</p></div><div class="actions">${actions}</div></div>`;
const card = (title, content, actions = '') =>
  `<section class="card"><div class="card-head"><h2>${title}</h2><div class="actions">${actions}</div></div>${content}</section>`;
function table(headers, rows, empty = 'Aucun élément pour le moment.') {
  return rows.length
    ? `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">${empty}</div>`;
}
const appName = (id) => snapshot.applications.find((a) => a.id === id)?.name || id;
const workerName = (id) => snapshot.workers.find((w) => w.id === id)?.name || '—';
function jobsTable(jobs) {
  return table(
    ['Job / application', 'Utilisateur', 'Modèle', 'Mode', 'État', 'Worker', 'Reçu', ''],
    jobs.map((j) => [
      `<span class="mono">${esc(j.id.slice(0, 8))}</span><small>${esc(appName(j.app_id))}</small>`,
      esc(j.external_id || 'Service'),
      esc(j.model),
      j.mode === 'chat' ? 'Chat' : 'Asynchrone',
      badge(j.status),
      esc(workerName(j.worker_id)),
      date(j.created_at),
      `<div class="actions">${button('inspect-job', j.id, 'Voir')}${['queued', 'running'].includes(j.status) ? button('cancel-job', j.id, 'Annuler', 'danger') : ''}</div>`,
    ]),
    'Les demandes reçues apparaîtront ici.',
  );
}
function dimension(id) {
  return (
    snapshot.applications.find((a) => a.id === id)?.name ||
    snapshot.keys.find((k) => k.id === id)?.name ||
    users.find((u) => u.id === id)?.external_id ||
    id ||
    'Service'
  );
}
function render() {
  if (!snapshot) return;
  document
    .querySelectorAll('[data-page]')
    .forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  const count = (s) => snapshot.counts.find((c) => c.status === s)?.count || 0;
  const pages = {
    overview: () =>
      heading('L’activité en un regard', 'Vos générations, vos capacités et vos applications.') +
      (!snapshot.workers.length
        ? '<div class="welcome"><h3>Préparez votre premier traitement</h3><p>Déclarez un modèle et un worker, puis créez une application et sa clé d’API. Les demandes seront mises en file et distribuées automatiquement.</p></div>'
        : '') +
      `<div class="metrics">${[
        ['Jobs en attente', count('queued')],
        ['Générations en cours', count('running')],
        [
          'Workers disponibles',
          `${snapshot.workers.filter((w) => w.enabled && w.status === 'available').length} / ${snapshot.workers.filter((w) => w.enabled).length}`,
        ],
        ['Jobs terminés', count('succeeded')],
      ]
        .map(
          ([l, n]) =>
            `<div class="metric"><span>${l}</span><strong>${typeof n === 'number' ? fmt(n) : n}</strong></div>`,
        )
        .join('')}</div>` +
      card(
        'Derniers traitements',
        jobsTable(snapshot.jobs.slice(0, 10)),
        button('page-queue', '', 'Voir la file →'),
      ) +
      '<div class="note">Les conversations interactives sont prioritaires, avec une part de capacité garantie aux traitements asynchrones. Une génération commencée continue jusqu’à son terme.</div>',
    queue: () =>
      heading(
        'Jobs et file d’attente',
        'Tous les jobs, avec filtres et pagination. Consultez un job pour voir son attente estimée.',
      ) +
      `<form id="queue-form" class="filters"><label>État<select name="status"><option value="">Tous</option>${['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'].map((s) => `<option value="${s}" ${queueQuery.status === s ? 'selected' : ''}>${labels[s]}</option>`).join('')}</select></label><label>Modèle<select name="model"><option value="">Tous</option>${snapshot.models.map((m) => `<option value="${esc(m.id)}" ${queueQuery.model === m.id ? 'selected' : ''}>${esc(m.id)}</option>`).join('')}</select></label><label>Identifiant du job<input name="search" value="${esc(queueQuery.search || '')}"></label><button class="primary">Filtrer</button></form>` +
      card(
        `${fmt(queueData.total)} traitement(s)`,
        jobsTable(queueData.data) +
          `<div class="pagination">${button('jobs-prev', '', '← Précédents')}<span>${queueData.data.length ? queueOffset + 1 : 0}–${queueOffset + queueData.data.length}</span>${button('jobs-next', '', 'Suivants →')}</div>`,
      ),
    workers: () =>
      heading(
        'Workers et modèles',
        'Modèles disponibles et capacité de chaque serveur.',
        button('new-model', '', '+ Modèle') + button('new-worker', '', '+ Worker', 'primary'),
      ) +
      `<div class="worker-grid">${snapshot.workers.map((w) => `<article class="worker"><h3>${esc(w.name)} ${badge(!w.enabled ? 'maintenance' : w.uncertain ? 'uncertain' : w.status)}</h3><p>${esc(w.url)}</p><p>${w.models.map(esc).join(' · ')}</p><div class="capacity">${Array.from({ length: w.concurrency }, (_, i) => `<span class="${i < w.occupied ? 'filled' : ''}"></span>`).join('')}</div><p>${w.occupied} / ${w.concurrency} places occupées${w.uncertain ? ` · ${w.uncertain} à vérifier` : ''}</p><div class="actions">${button('edit-worker', w.id, 'Modifier')}${button('probe-worker', w.id, 'Vérifier')}${w.uncertain ? button('release-worker', w.id, 'Confirmer l’arrêt', 'danger') : ''}</div></article>`).join('') || '<p class="empty">Aucun worker déclaré.</p>'}</div>` +
      card(
        'Catalogue des modèles',
        table(
          ['Modèle', 'Entrée', 'Contexte', 'Sortie maximale', ''],
          snapshot.models.map((m) => [
            esc(m.id),
            m.vision ? 'Texte et vision' : 'Texte',
            fmt(m.context_tokens),
            fmt(m.max_output_tokens),
            button('edit-model', m.id, 'Modifier'),
          ]),
        ),
      ),
    applications: () =>
      heading(
        'Applications et clés',
        'Séparez les accès, les politiques et la consommation.',
        button('new-application', '', '+ Application', 'primary'),
      ) +
      snapshot.applications
        .map((a) =>
          card(
            `${esc(a.name)} ${badge(a.enabled ? 'available' : 'disabled')}`,
            `<div class="card-body muted small-text">Utilisateur requis : ${a.require_user ? 'oui' : 'non'} · ${a.callback_bases.length} destination(s) de callback</div>` +
              table(
                ['Clé', 'État', 'Modèles / modes', ''],
                snapshot.keys
                  .filter((k) => k.app_id === a.id)
                  .map((k) => [
                    `${esc(k.name)}<small class="mono">${esc(k.prefix)}…</small>`,
                    badge(k.enabled ? 'available' : 'disabled'),
                    `${esc(k.restrictions.models?.join(', ') || 'Tous modèles')}<small>${esc(k.restrictions.modes?.join(', ') || 'Tous modes')}</small>`,
                    `<div class="actions">${button('edit-key', k.id, 'Modifier')}${button('rotate-key', k.id, 'Remplacer')}${button('key-quota', k.id, 'Budget')}</div>`,
                  ]),
              ),
            button('edit-application', a.id, 'Modifier') +
              button('app-quota', a.id, 'Budget') +
              button('callback-secret', a.id, 'Secret callback') +
              button('new-key', a.id, '+ Clé'),
          ),
        )
        .join(''),
    users: () =>
      heading(
        'Utilisateurs et quotas',
        'Création au premier appel ; les exceptions remplacent la politique utilisateur par défaut.',
      ) +
      `<div class="filters"><label>Application<select id="user-app"><option value="">Toutes</option>${snapshot.applications.map((a) => `<option value="${esc(a.id)}" ${userApp === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>${button('load-users', '', 'Actualiser')}</div>` +
      card(
        'Utilisateurs',
        table(
          ['Utilisateur', 'Application', 'Politique', 'Première demande', ''],
          users.map((u) => [
            esc(u.external_id),
            esc(appName(u.app_id)),
            u.policy ? 'Exception individuelle' : 'Par défaut',
            date(u.created_at),
            `<div class="actions">${button('edit-user', u.id, 'Quota')}${button('user-quota', u.id, 'Budget')}${button('credit-user', u.id, 'Recharger')}</div>`,
          ]),
        ) +
          `<div class="pagination">${button('users-prev', '', '← Précédents')}<span>${users.length ? offset + 1 : 0}–${offset + users.length}</span>${button('users-next', '', 'Suivants →')}</div>`,
      ),
    usage: () =>
      heading('Consommation', 'Tokens, tentatives et mesures estimées.') +
      `<form id="usage-form" class="filters"><label>Application<select name="app_id"><option value="">Toutes</option>${snapshot.applications.map((a) => `<option value="${esc(a.id)}" ${usageQuery.app_id === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label><label>Regrouper par<select name="group">${[
        ['application', 'Application'],
        ['key', 'Clé'],
        ['user', 'Utilisateur'],
        ['model', 'Modèle'],
        ['day', 'Jour'],
      ]
        .map(([v, l]) => `<option value="${v}" ${usageQuery.group === v ? 'selected' : ''}>${l}</option>`)
        .join(
          '',
        )}</select></label><label>Depuis<input type="date" name="since" value="${esc(usageQuery.since || '')}"></label><label>Jusqu’au<input type="date" name="until" value="${esc(usageQuery.until || '')}"></label><button class="primary">Afficher</button></form>` +
      card(
        'Consommation sur la période',
        table(
          ['Groupe', 'Entrée', 'Sortie', 'Tentatives', 'Estimées'],
          (usage?.data || []).map((r) => [
            esc(dimension(r.dimension)),
            fmt(r.prompt_tokens),
            fmt(r.completion_tokens),
            fmt(r.attempts),
            fmt(r.estimated_attempts),
          ]),
          'Affichez la consommation des 30 derniers jours ou choisissez une période.',
        ),
      ),
    callbacks: () =>
      heading('Livraison des résultats', 'Réessais pendant 24 heures, sans relancer la génération.') +
      card(
        'Callbacks récents',
        table(
          ['Événement / job', 'État', 'Tentatives', 'HTTP', 'Livré / prochain essai', ''],
          snapshot.callbacks.map((c) => [
            `<span class="mono">${esc(c.id.slice(0, 8))}</span><small class="mono">${esc(c.job_id.slice(0, 8))}</small>`,
            badge(c.status),
            c.attempts,
            c.last_status || '—',
            date(c.delivered_at || c.next_at),
            button('retry-callback', c.id, 'Relivrer'),
          ]),
        ),
      ),
    settings: () =>
      heading(
        'Administration',
        'Comptes et journal des actions.',
        button('new-account', '', '+ Administrateur', 'primary'),
      ) +
      card(
        'Comptes',
        table(
          ['Identifiant', 'Création', ''],
          accounts.map((a) => [
            esc(a.username),
            date(a.created_at),
            button('account-password', a.id, 'Changer le mot de passe'),
          ]),
        ),
      ) +
      card(
        'Journal récent',
        table(
          ['Date', 'Administrateur', 'Action', 'Cible'],
          snapshot.audit.map((a) => [
            date(a.created_at),
            esc(a.username || 'Système'),
            esc(a.action),
            `<span class="mono">${esc(a.target || '—')}</span>`,
          ]),
        ),
      ) +
      '<div class="note">La rétention, les délais et les limites globales se règlent dans le fichier d’environnement. La sauvegarde utilise la commande documentée <code>npm run backup</code>.</div>',
  };
  $('#content').innerHTML = pages[page]();
}
function modal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  if (!$('#modal').open) $('#modal').showModal();
}
function secret(title, value) {
  modal(
    title,
    `<p class="muted">Copiez ce secret maintenant. Il ne sera plus affiché ensuite.</p><div class="secret" id="secret-value">${esc(value)}</div><button data-action="copy-secret" class="primary">Copier</button>`,
  );
}
function field(name, label, value = '', type = 'text', hint = '') {
  return type === 'checkbox'
    ? `<label class="check"><input name="${name}" type="checkbox" ${value ? 'checked' : ''}>${label}</label>`
    : `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${type === 'number' ? 'min="0" step="any"' : ''}>${hint ? `<small class="muted">${hint}</small>` : ''}</label>`;
}
function windowRow(w = { hours: 6, tokens: 10000, enabled: true }) {
  return `<div class="window-row"><input aria-label="Fenêtre active" type="checkbox" data-window="enabled" ${w.enabled !== false ? 'checked' : ''}><label>Heures<input type="number" min="0.001" step="any" data-window="hours" value="${esc(w.hours)}"></label><label>Tokens<input type="number" min="0" step="1" data-window="tokens" value="${esc(w.tokens)}"></label><button type="button" data-action="remove-window" aria-label="Retirer">×</button></div>`;
}
function policy(name, title, p = {}) {
  p ||= {};
  return `<fieldset class="policy" data-policy="${name}"><legend>${title}</legend><div class="form-grid"><label>Tokens comptés<select data-rule="count">${[
    ['both', 'Entrée et sortie'],
    ['input', 'Entrée uniquement'],
    ['output', 'Sortie uniquement'],
  ]
    .map(([v, l]) => `<option value="${v}" ${(p.count || 'both') === v ? 'selected' : ''}>${l}</option>`)
    .join(
      '',
    )}</select></label><label>Crédit initial<input type="number" min="0" step="1" data-rule="tokens" value="${esc(p.credit?.tokens || 0)}"></label></div><label class="check"><input type="checkbox" data-rule="credit" ${p.credit?.enabled ? 'checked' : ''}>Limiter par crédit</label><p class="muted small-text">Les recharges s’ajoutent au crédit initial. Les fenêtres ci-dessous sont glissantes.</p><div class="windows">${(p.windows || []).map(windowRow).join('')}</div><button type="button" data-action="add-window">+ Fenêtre glissante</button></fieldset>`;
}
function readPolicy(form, name) {
  const el = form.querySelector(`[data-policy="${name}"]`);
  return {
    count: el.querySelector('[data-rule=count]').value,
    credit: {
      enabled: el.querySelector('[data-rule=credit]').checked,
      tokens: Number(el.querySelector('[data-rule=tokens]').value),
    },
    windows: [...el.querySelectorAll('.window-row')].map((r) => ({
      hours: Number(r.querySelector('[data-window=hours]').value),
      tokens: Number(r.querySelector('[data-window=tokens]').value),
      enabled: r.querySelector('[data-window=enabled]').checked,
    })),
  };
}
function form(title, html, submit) {
  modal(
    title,
    `<form id="edit-form">${html}<p class="error" id="form-error" role="alert"></p><div class="form-actions"><button type="button" data-action="close">Annuler</button><button class="primary" type="submit">Enregistrer</button></div></form>`,
  );
  $('#edit-form').onsubmit = async (event) => {
    event.preventDefault();
    const el = event.currentTarget;
    const b = el.querySelector('[type=submit]');
    b.disabled = true;
    try {
      const r = await submit(el, new FormData(el));
      if (!r?.keepOpen) $('#modal').close();
      await refresh();
      toast('Modification enregistrée.');
    } catch (e) {
      if ($('#form-error')) $('#form-error').textContent = e.message;
      else toast(e.message, true);
    } finally {
      if (b.isConnected) b.disabled = false;
    }
  };
}
function editApplication(a) {
  form(
    a ? 'Modifier l’application' : 'Nouvelle application',
    field('name', 'Nom', a?.name) +
      field('enabled', 'Application active', a?.enabled ?? true, 'checkbox') +
      field('require_user', 'Identifiant utilisateur obligatoire', a?.require_user ?? true, 'checkbox') +
      field(
        'bases',
        'Destinations de callback autorisées',
        (a?.callback_bases || []).join(', '),
        'text',
        'URL de base avec chemin, séparées par des virgules.',
      ) +
      policy('app', 'Quota global', a?.policy) +
      policy('default', 'Quota de chaque utilisateur par défaut', a?.default_user_policy),
    async (el, data) => {
      const r = await api(a ? `/applications/${a.id}` : '/applications', a ? 'PUT' : 'POST', {
        name: data.get('name'),
        enabled: data.has('enabled'),
        require_user: data.has('require_user'),
        callback_bases: split(data.get('bases')),
        policy: readPolicy(el, 'app'),
        default_user_policy: readPolicy(el, 'default'),
      });
      if (!a) {
        secret('Secret de signature des callbacks', r.callback_secret);
        return { keepOpen: true };
      }
    },
  );
}
function editKey(k, appId) {
  form(
    k ? 'Modifier la clé' : 'Nouvelle clé d’API',
    field('name', 'Nom', k?.name) +
      field('enabled', 'Clé active', k?.enabled ?? true, 'checkbox') +
      field(
        'models',
        'Modèles autorisés',
        (k?.restrictions.models || []).join(', '),
        'text',
        'Vide : tous. Identifiants séparés par des virgules.',
      ) +
      field(
        'modes',
        'Modes autorisés',
        (k?.restrictions.modes || []).join(', '),
        'text',
        'Vide : tous. Valeurs : async, sync, stream.',
      ) +
      field(
        'ips',
        'IP et réseaux autorisés',
        (k?.restrictions.ips || []).join(', '),
        'text',
        'Vide : toutes. Adresses ou CIDR séparés par des virgules.',
      ) +
      policy('key', 'Quota de la clé', k?.policy),
    async (el, data) => {
      const r = await api(k ? `/keys/${k.id}` : `/applications/${appId}/keys`, k ? 'PUT' : 'POST', {
        name: data.get('name'),
        enabled: data.has('enabled'),
        restrictions: {
          models: split(data.get('models')),
          modes: split(data.get('modes')),
          ips: split(data.get('ips')),
        },
        policy: readPolicy(el, 'key'),
      });
      if (!k) {
        secret('Clé d’API', r.api_key);
        return { keepOpen: true };
      }
    },
  );
}
function editModel(m) {
  form(
    m ? 'Modifier le modèle' : 'Déclarer un modèle',
    (m ? '' : field('id', 'Identifiant exact du modèle')) +
      `<div class="form-grid">${field('context', 'Taille du contexte', m?.context_tokens || 32768, 'number')}${field('output', 'Sortie maximale', m?.max_output_tokens || 4096, 'number')}${field('ratio', 'Tokens estimés par caractère', m?.input_tokens_per_char || 1, 'number')}${field('image', 'Tokens estimés par image', m?.image_tokens || 8192, 'number')}</div>` +
      field('vision', 'Accepte les images', m?.vision || false, 'checkbox') +
      '<p class="muted small-text">Ajustez les estimations à vos modèles. Le comptage réel régularise la consommation.</p>',
    async (el, data) =>
      api(m ? `/models/${encodeURIComponent(m.id)}` : '/models', m ? 'PUT' : 'POST', {
        id: m?.id || data.get('id'),
        context_tokens: Number(data.get('context')),
        max_output_tokens: Number(data.get('output')),
        input_tokens_per_char: Number(data.get('ratio')),
        image_tokens: Number(data.get('image')),
        vision: data.has('vision'),
      }),
  );
}
function editWorker(w) {
  form(
    w ? 'Modifier le worker' : 'Nouveau worker',
    field('name', 'Nom', w?.name) +
      field('url', 'URL de base OpenAI', w?.url || '', 'url', 'Exemple : http://serveur:8000/v1') +
      field('secret', w ? 'Nouvelle clé worker (vide : conserver)' : 'Clé d’API worker', '', 'password') +
      field(
        'models',
        'Modèles servis',
        (w?.models || []).join(', '),
        'text',
        'Identifiants du catalogue séparés par des virgules.',
      ) +
      field('concurrency', 'Générations simultanées', w?.concurrency || 1, 'number') +
      field('enabled', 'Accepter de nouveaux jobs', w?.enabled ?? true, 'checkbox'),
    async (el, data) =>
      api(w ? `/workers/${w.id}` : '/workers', w ? 'PUT' : 'POST', {
        name: data.get('name'),
        url: data.get('url'),
        ...(data.get('secret') || !w ? { secret: data.get('secret') } : {}),
        models: split(data.get('models')),
        concurrency: Number(data.get('concurrency')),
        enabled: data.has('enabled'),
      }),
  );
}
async function loadUsers() {
  users = (await api(`/users?offset=${offset}&app_id=${encodeURIComponent(userApp)}`)).data;
  render();
}
async function loadJobs() {
  queueData = await api(`/jobs?${new URLSearchParams({ ...queueQuery, offset: queueOffset })}`);
  render();
}
async function quotas(appId, keyId, userId) {
  const r = await api(
    `/quotas?${new URLSearchParams({ app_id: appId, ...(keyId ? { key_id: keyId } : {}), ...(userId ? { user_id: userId } : {}) })}`,
  );
  modal(
    'Budgets disponibles',
    r.data
      .map(
        (q) =>
          `<h3>${esc({ application: 'Application', key: 'Clé', user: 'Utilisateur' }[q.scope])}</h3>` +
          table(
            ['Limite', 'Consommés', 'Réservés', 'Disponibles'],
            [
              ...(q.credit
                ? [['Crédit', fmt(q.credit.used), fmt(q.credit.reserved), fmt(q.credit.available)]]
                : []),
              ...q.windows.map((w) => [
                `${w.hours} h · ${fmt(w.limit)} tokens`,
                fmt(w.used),
                fmt(w.reserved),
                fmt(w.available),
              ]),
            ],
            'Aucune restriction à ce niveau.',
          ) +
          button('credit-scope', `${q.scope}:${q.id}`, 'Recharger le crédit') +
          '<br><br>',
      )
      .join(''),
  );
}
function credit(scope, id) {
  form(
    'Recharger le crédit',
    field('tokens', 'Tokens à ajouter', 10000, 'number') + field('note', 'Motif'),
    async (el, data) =>
      api('/credits', 'POST', {
        scope,
        scope_id: id,
        tokens: Number(data.get('tokens')),
        note: data.get('note'),
      }),
  );
}
document.addEventListener('click', async (event) => {
  const nav = event.target.closest('[data-page]');
  const control = event.target.closest('[data-action]');
  try {
    if (nav) {
      page = nav.dataset.page;
      render();
      if (page === 'queue') await loadJobs();
      if (page === 'users') await loadUsers();
      if (page === 'settings') {
        accounts = (await api('/accounts')).data;
        render();
      }
      return;
    }
    if (!control) return;
    const { action, id } = control.dataset;
    if (action === 'close') return $('#modal').close();
    if (action === 'page-queue') {
      page = 'queue';
      return await loadJobs();
    }
    if (action === 'new-application') return editApplication();
    if (action === 'edit-application') return editApplication(snapshot.applications.find((a) => a.id === id));
    if (action === 'new-key') return editKey(null, id);
    if (action === 'edit-key') return editKey(snapshot.keys.find((k) => k.id === id));
    if (action === 'new-model') return editModel();
    if (action === 'edit-model') return editModel(snapshot.models.find((m) => m.id === id));
    if (action === 'new-worker') return editWorker();
    if (action === 'edit-worker') return editWorker(snapshot.workers.find((w) => w.id === id));
    if (action === 'add-window')
      return control
        .closest('.policy')
        .querySelector('.windows')
        .insertAdjacentHTML('beforeend', windowRow());
    if (action === 'remove-window') return control.closest('.window-row').remove();
    if (action === 'copy-secret') {
      await navigator.clipboard.writeText($('#secret-value').textContent);
      return toast('Secret copié.');
    }
    if (action === 'app-quota') return await quotas(id);
    if (action === 'key-quota') {
      const k = snapshot.keys.find((k) => k.id === id);
      return await quotas(k.app_id, id);
    }
    if (action === 'user-quota') {
      const u = users.find((u) => u.id === id);
      return await quotas(u.app_id, null, id);
    }
    if (action === 'credit-user') return credit('user', id);
    if (action === 'credit-scope') {
      const [scope, scopeId] = id.split(':');
      return credit(scope, scopeId);
    }
    if (action === 'load-users') {
      userApp = $('#user-app').value;
      offset = 0;
      return await loadUsers();
    }
    if (action === 'users-next') {
      offset += 100;
      return await loadUsers();
    }
    if (action === 'users-prev') {
      offset = Math.max(0, offset - 100);
      return await loadUsers();
    }
    if (action === 'jobs-next') {
      if (queueOffset + 100 < queueData.total) queueOffset += 100;
      return await loadJobs();
    }
    if (action === 'jobs-prev') {
      queueOffset = Math.max(0, queueOffset - 100);
      return await loadJobs();
    }
    if (action === 'edit-user') {
      const u = users.find((u) => u.id === id);
      return form(
        `Quota de ${u.external_id}`,
        field('inherit', 'Utiliser la politique de l’application', !u.policy, 'checkbox') +
          policy(
            'user',
            'Exception individuelle',
            u.policy || snapshot.applications.find((a) => a.id === u.app_id)?.default_user_policy,
          ),
        async (el, data) => {
          await api(`/users/${id}`, 'PUT', { policy: data.has('inherit') ? null : readPolicy(el, 'user') });
          await loadUsers();
        },
      );
    }
    if (action === 'inspect-job') {
      const job = await api(`/jobs/${id}`);
      return modal(
        `Job ${id.slice(0, 8)}`,
        `${badge(job.status)}<pre>${esc(JSON.stringify(job, null, 2))}</pre>`,
      );
    }
    if (action === 'probe-worker') {
      await api(`/workers/${id}/probe`, 'POST', {});
      toast('Vérification effectuée.');
    }
    if (action === 'release-worker') {
      if (!confirm('Avez-vous vérifié l’arrêt des générations concernées sur le serveur distant ?')) return;
      await api(`/workers/${id}/release-uncertain`, 'POST', { confirmed_remote_stopped: true });
      toast('Capacité libérée.');
    }
    if (action === 'cancel-job') {
      await api(`/jobs/${id}/cancel`, 'POST', {});
      toast('Annulation demandée.');
    }
    if (action === 'retry-callback') {
      await api(`/callbacks/${id}/retry`, 'POST', {});
      toast('Livraison reprogrammée.');
    }
    if (action === 'rotate-key') {
      if (!confirm('Remplacer la clé invalide immédiatement sa valeur actuelle. Continuer ?')) return;
      secret('Nouvelle clé d’API', (await api(`/keys/${id}/rotate`, 'POST', {})).api_key);
    }
    if (action === 'callback-secret') {
      if (!confirm('Remplacer le secret de signature ? Les prochains envois utiliseront le nouveau secret.'))
        return;
      secret(
        'Nouveau secret de callback',
        (await api(`/applications/${id}/rotate-callback-secret`, 'POST', {})).callback_secret,
      );
    }
    if (action === 'new-account')
      return form(
        'Nouvel administrateur',
        field('username', 'Identifiant') +
          field('password', 'Mot de passe (12 caractères minimum)', '', 'password'),
        async (el, data) => {
          await api('/accounts', 'POST', Object.fromEntries(data));
          accounts = (await api('/accounts')).data;
        },
      );
    if (action === 'account-password')
      return form(
        'Changer le mot de passe',
        field('password', 'Nouveau mot de passe (12 caractères minimum)', '', 'password'),
        async (el, data) => api(`/accounts/${id}/password`, 'PUT', { password: data.get('password') }),
      );
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
});
document.addEventListener('submit', async (event) => {
  if (event.target.id === 'queue-form') {
    event.preventDefault();
    queueQuery = Object.fromEntries([...new FormData(event.target)].filter(([, v]) => v));
    queueOffset = 0;
    try {
      await loadJobs();
    } catch (e) {
      toast(e.message, true);
    }
    return;
  }
  if (event.target.id !== 'usage-form') return;
  event.preventDefault();
  usageQuery = Object.fromEntries([...new FormData(event.target)].filter(([, v]) => v));
  const q = { ...usageQuery };
  if (q.until) q.until += 'T23:59:59.999Z';
  try {
    usage = await api(`/usage?${new URLSearchParams(q)}`);
    render();
  } catch (e) {
    toast(e.message, true);
  }
});
$('#close-modal').onclick = () => $('#modal').close();
$('#login-form').onsubmit = async (event) => {
  event.preventDefault();
  try {
    const a = await api('/login', 'POST', Object.fromEntries(new FormData(event.target)));
    event.target.reset();
    $('#login-error').textContent = '';
    await showShell(a);
  } catch (e) {
    $('#login-error').textContent = e.message;
  }
};
$('#logout').onclick = async () => {
  try {
    await api('/logout', 'POST', {});
    showLogin();
  } catch (e) {
    toast(e.message, true);
  }
};
try {
  await showShell(await api('/me'));
} catch {
  showLogin();
}
