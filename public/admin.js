let myRole = null;
let orgs = [];

const ROLE_LABELS = { super_admin: 'Super Admin', operations: 'Operations', installer: 'Installer' };

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'include', ...opts });
  if (res.status === 401) {
    window.location.href = '/admin-login.html';
    throw new Error('unauthenticated');
  }
  return res;
}

async function loadMe() {
  const res = await api('/admin/me');
  const data = await res.json();
  myRole = data.role;
  document.getElementById('whoami').textContent = `Admin (${ROLE_LABELS[myRole] || myRole})`;
  document.getElementById('teamCard').style.display = myRole === 'super_admin' ? 'block' : 'none';
  document.getElementById('orgForm').style.display = myRole === 'super_admin' ? 'block' : 'none';
  document.getElementById('orgUserSection').style.display = myRole === 'installer' ? 'none' : 'block';
  document.getElementById('addPropertyCard').style.display = myRole === 'installer' ? 'none' : 'block';
}

// Assigning staff to clients is super_admin-only (see src/routes/admin.ts) --
// everyone else just sees who's assigned, no controls.
async function renderAssignmentCell(cell, orgId, team) {
  cell.innerHTML = 'Loading…';
  const res = await api(`/admin/organizations/${orgId}/assignments`);
  const assignments = (await res.json()).assignments;

  cell.innerHTML = '';
  assignments.forEach((a) => {
    const chip = document.createElement('span');
    chip.className = 'role-pill';
    chip.style.cssText = 'margin:0 4px 4px 0; display:inline-flex; align-items:center; gap:5px;';
    chip.innerHTML = `${a.name} (${a.role === 'operations' ? 'Ops' : 'Installer'})`;
    const remove = document.createElement('a');
    remove.href = '#';
    remove.textContent = '✕';
    remove.style.textDecoration = 'none';
    remove.addEventListener('click', async (e) => {
      e.preventDefault();
      await api(`/admin/organizations/${orgId}/assignments/${a.id}`, { method: 'DELETE' });
      renderAssignmentCell(cell, orgId, team);
    });
    chip.appendChild(remove);
    cell.appendChild(chip);
  });

  const unassigned = team.filter((t) => t.role !== 'super_admin' && !assignments.some((a) => a.id === t.id));
  if (unassigned.length > 0) {
    const select = document.createElement('select');
    select.style.cssText = 'display:block; margin-top:6px; font-size:12px; font-weight:normal; padding:4px 6px;';
    select.innerHTML = '<option value="">+ assign staff…</option>' + unassigned.map((t) => `<option value="${t.id}">${t.name} (${ROLE_LABELS[t.role]})</option>`).join('');
    select.addEventListener('change', async () => {
      if (!select.value) return;
      await api(`/admin/organizations/${orgId}/assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminUserId: Number(select.value) }),
      });
      renderAssignmentCell(cell, orgId, team);
    });
    cell.appendChild(select);
  } else if (assignments.length === 0) {
    cell.appendChild(Object.assign(document.createElement('span'), { className: 'hint', textContent: 'No staff to assign yet' }));
  }
}

async function loadOrgs() {
  const res = await api('/admin/organizations');
  const data = await res.json();
  orgs = data.organizations;

  const team = myRole === 'super_admin' ? (await (await api('/admin/team')).json()).team : [];

  const tbody = document.getElementById('orgsBody');
  tbody.innerHTML = '';
  const typeLabels = { HA: 'Housing Association', LA: 'Local Authority', other: 'Other' };
  orgs.forEach((o) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${o.name}</td><td>${typeLabels[o.type] || o.type}</td><td>${o.property_count}</td><td class="assign-cell"></td>`;
    tbody.appendChild(tr);
    const cell = tr.querySelector('.assign-cell');
    if (myRole === 'super_admin') {
      renderAssignmentCell(cell, o.id, team);
    } else {
      cell.innerHTML = '<span class="hint">—</span>';
    }
  });

  [document.getElementById('propertyOrg'), document.getElementById('orgFilter'), document.getElementById('orgUserOrg')].forEach((select) => {
    const keep = select.id === 'orgFilter' ? select.value : '';
    const placeholder = select.id === 'orgFilter' ? '<option value="">All organizations</option>' : select.id === 'propertyOrg' ? '<option value="">— None —</option>' : '';
    select.innerHTML = placeholder + orgs.map((o) => `<option value="${o.id}">${o.name}</option>`).join('');
    if (keep) select.value = keep;
  });
}

// Turns a cell showing a possibly-missing field into a click-to-fill-in
// control — used for whatever a batch CSV import (or a quick manual add)
// left blank, without a separate "edit property" page.
function renderCompletableField(td, propertyId, apiField, value) {
  if (value) {
    td.textContent = value;
    return;
  }
  if (myRole === 'installer') {
    td.innerHTML = '<span class="hint">—</span>';
    return;
  }
  const link = document.createElement('a');
  link.href = '#';
  link.textContent = '+ add';
  link.addEventListener('click', (e) => {
    e.preventDefault();
    td.innerHTML = '';
    const input = document.createElement('input');
    input.type = apiField === 'tenantEmail' ? 'email' : 'text';
    input.style.cssText = 'font-size:13px; font-weight:normal; padding:4px 6px; width:140px;';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn';
    save.style.cssText = 'padding:5px 10px; font-size:12px; margin-left:4px;';
    save.textContent = 'Save';
    save.addEventListener('click', async () => {
      if (!input.value.trim()) return;
      const res = await api(`/admin/properties/${propertyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [apiField]: input.value.trim() }),
      });
      if (res.ok) {
        loadProperties();
      } else {
        const data = await res.json();
        alert(`Error: ${data.error}`);
      }
    });
    td.appendChild(input);
    td.appendChild(save);
    input.focus();
  });
  td.appendChild(link);
}

function renderPropertyRow(p) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${p.id}</td>
    <td>${p.address}</td>
    <td class="postcode-cell"></td>
    <td>${p.tenant_name}</td>
    <td>${p.fox_device_sn}</td>
    <td><code>${p.signup_code || '—'}</code></td>
    <td class="email-cell"></td>
    <td>${p.has_fox_token ? '✓' : '—'}</td>
    <td>${p.connection_date ? new Date(p.connection_date).toLocaleDateString('en-GB') : '—'}</td>
    <td>${p.last_reading_at ? new Date(p.last_reading_at).toLocaleString('en-GB') : 'never'}</td>
    <td>${p.last_rollup_date || 'never'}</td>
    <td><a href="/oauth/fox/authorize?propertyId=${p.id}" target="_blank">Fox consent link</a></td>
  `;
  renderCompletableField(tr.querySelector('.postcode-cell'), p.id, 'postcode', p.postcode);
  renderCompletableField(tr.querySelector('.email-cell'), p.id, 'tenantEmail', p.tenant_email);
  return tr;
}

const PROPERTY_COLUMNS = ['ID', 'Address', 'Postcode', 'Tenant', 'Device SN', 'Signup code', 'Email', 'Fox linked', 'Connection date', 'Last reading', 'Last rollup', ''];

async function loadProperties() {
  const res = await api('/admin/properties');
  const data = await res.json();
  const filter = document.getElementById('orgFilter').value;

  const groups = new Map(); // organization_name (or null) -> properties[]
  data.properties.forEach((p) => {
    if (filter && String(p.organization_id ?? '') !== filter) return;
    const key = p.organization_name || null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });

  const container = document.getElementById('propertiesGroups');
  container.innerHTML = '';

  // Named organizations first (alphabetical, matching the backend order), unassigned last.
  const orderedKeys = [...groups.keys()].filter((k) => k !== null).sort();
  if (groups.has(null)) orderedKeys.push(null);

  if (orderedKeys.length === 0) {
    container.innerHTML = '<p class="hint">No properties match this filter.</p>';
    return;
  }

  orderedKeys.forEach((key) => {
    const section = document.createElement('div');
    section.style.marginTop = '20px';
    const heading = document.createElement('h2');
    heading.style.fontSize = '13px';
    heading.textContent = key || 'Unassigned';
    section.appendChild(heading);

    const scroll = document.createElement('div');
    scroll.style.overflowX = 'auto';
    const table = document.createElement('table');
    table.className = 'admin-table';
    table.innerHTML = `<thead><tr>${PROPERTY_COLUMNS.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody></tbody>`;
    const tbody = table.querySelector('tbody');
    groups.get(key).forEach((p) => tbody.appendChild(renderPropertyRow(p)));
    scroll.appendChild(table);
    section.appendChild(scroll);
    container.appendChild(section);
  });
}

async function loadTeam() {
  if (myRole !== 'super_admin') return;
  const res = await api('/admin/team');
  const data = await res.json();
  const tbody = document.getElementById('teamBody');
  tbody.innerHTML = '';
  data.team.forEach((t) => {
    const tr = document.createElement('tr');
    const clients = t.assigned_clients && t.assigned_clients.length ? t.assigned_clients.join(', ') : (t.role === 'super_admin' ? 'All (Super Admin)' : '—');
    tr.innerHTML = `
      <td>${t.name}</td>
      <td>${t.email}</td>
      <td><span class="hint">${ROLE_LABELS[t.role] || t.role}</span></td>
      <td>${clients}</td>
      <td><a href="#" data-id="${t.id}">Remove</a></td>
    `;
    tr.querySelector('a').addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm(`Remove ${t.name}?`)) return;
      await api(`/admin/team/${t.id}`, { method: 'DELETE' });
      loadTeam();
    });
    tbody.appendChild(tr);
  });
}

document.getElementById('orgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: document.getElementById('orgName').value,
    type: document.getElementById('orgType').value,
  };
  const res = await api('/admin/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const msg = document.getElementById('orgMessage');
  msg.style.display = 'block';
  if (res.ok) {
    msg.textContent = `Added ${body.name}. Invite their portfolio user below, then assign properties to them using the dropdown in "Add a property".`;
    document.getElementById('orgForm').reset();
    await loadOrgs();
    loadProperties();
  } else {
    msg.textContent = `Error: ${data.error}`;
  }
});

document.getElementById('orgUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const organizationId = document.getElementById('orgUserOrg').value;
  const body = {
    name: document.getElementById('orgUserName').value,
    email: document.getElementById('orgUserEmail').value,
    role: document.getElementById('orgUserRole').value,
  };
  const res = await api(`/admin/organizations/${organizationId}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const msg = document.getElementById('orgUserMessage');
  msg.style.display = 'block';
  if (res.ok) {
    msg.textContent = `Invited ${body.name}. They can sign in at /portfolio-login.html once they have an email link.`;
    document.getElementById('orgUserForm').reset();
  } else {
    msg.textContent = `Error: ${data.error}`;
  }
});

document.getElementById('orgFilter').addEventListener('change', loadProperties);

document.getElementById('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    address: document.getElementById('address').value,
    postcode: document.getElementById('postcode').value || undefined,
    tenantName: document.getElementById('tenantName').value,
    foxDeviceSn: document.getElementById('foxDeviceSn').value,
    tenantEmail: document.getElementById('tenantEmail').value || undefined,
    arraySizeKwp: document.getElementById('arraySizeKwp').value ? Number(document.getElementById('arraySizeKwp').value) : undefined,
    batteryCapacityKwh: document.getElementById('batteryCapacityKwh').value ? Number(document.getElementById('batteryCapacityKwh').value) : undefined,
    organizationId: document.getElementById('propertyOrg').value ? Number(document.getElementById('propertyOrg').value) : undefined,
  };
  const res = await api('/admin/properties', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const msg = document.getElementById('addMessage');
  msg.style.display = 'block';
  if (res.ok) {
    msg.innerHTML = `Created property #${data.id}. Signup code: <code>${data.signupCode}</code> — give this to the tenant. <a href="${data.foxAuthorizeUrl}" target="_blank">Fox consent link</a>`;
    document.getElementById('addForm').reset();
    loadOrgs();
    loadProperties();
  } else {
    msg.textContent = `Error: ${data.error}`;
  }
});

document.getElementById('teamForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: document.getElementById('teamName').value,
    email: document.getElementById('teamEmail').value,
    role: document.getElementById('teamRole').value,
  };
  const res = await api('/admin/team', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const msg = document.getElementById('teamMessage');
  msg.style.display = 'block';
  if (res.ok) {
    msg.textContent = 'Team member invited — they can sign in at /admin-login.html once they have an email link.';
    document.getElementById('teamForm').reset();
    loadTeam();
  } else {
    msg.textContent = `Error: ${data.error}`;
  }
});

// Minimal CSV parser — handles quoted fields (so a quoted address containing
// a comma doesn't split into two columns) without pulling in a library.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function renderCsvResults(results, properties) {
  const container = document.getElementById('csvResults');
  container.innerHTML = '';
  const created = results.filter((r) => r.status === 'created');
  const errored = results.filter((r) => r.status === 'error');

  const summary = document.createElement('p');
  summary.className = 'hint';
  summary.style.marginBottom = '12px';
  summary.textContent = `${created.length} created, ${errored.length} failed.`;
  container.appendChild(summary);

  if (created.length > 0) {
    const table = document.createElement('table');
    table.className = 'admin-table';
    table.innerHTML = '<thead><tr><th>Address</th><th>Signup code</th><th>Fox consent link</th><th>Postcode</th><th>Tenant email</th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');
    created.forEach((r) => {
      const input = properties[r.index];
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${input.address}</td><td><code>${r.signupCode}</code></td>` +
        `<td><a href="${r.foxAuthorizeUrl}" target="_blank">Open</a></td><td class="pc"></td><td class="em"></td>`;
      renderCompletableField(tr.querySelector('.pc'), r.id, 'postcode', input.postcode);
      renderCompletableField(tr.querySelector('.em'), r.id, 'tenantEmail', input.tenantEmail);
      tbody.appendChild(tr);
    });
    container.appendChild(table);
  }

  if (errored.length > 0) {
    const list = document.createElement('ul');
    list.style.cssText = 'font-size:13px; color:var(--charcoal-light); margin-top:12px;';
    errored.forEach((r) => {
      const li = document.createElement('li');
      li.textContent = `Row ${r.index + 2}: ${r.error}`; // +2: 1-indexed, plus the header row
      list.appendChild(li);
    });
    container.appendChild(list);
  }
}

document.getElementById('csvImportBtn').addEventListener('click', async () => {
  const file = document.getElementById('csvFile').files[0];
  const results = document.getElementById('csvResults');
  if (!file) {
    results.innerHTML = '<p class="hint">Choose a CSV file first.</p>';
    return;
  }

  const rows = parseCsv(await file.text());
  if (rows.length < 2) {
    results.innerHTML = '<p class="hint">No data rows found — is the first row a header?</p>';
    return;
  }

  const header = rows[0].map((h) => h.trim());
  const properties = rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = (r[i] || '').trim(); });
    return {
      address: obj.address || undefined,
      postcode: obj.postcode || undefined,
      tenantName: obj.tenantName || undefined,
      foxDeviceSn: obj.foxDeviceSn || undefined,
      tenantEmail: obj.tenantEmail || undefined,
      arraySizeKwp: obj.arraySizeKwp ? Number(obj.arraySizeKwp) : undefined,
      batteryCapacityKwh: obj.batteryCapacityKwh ? Number(obj.batteryCapacityKwh) : undefined,
      organizationId: obj.organizationId ? Number(obj.organizationId) : undefined,
    };
  });

  results.innerHTML = '<p class="hint">Importing…</p>';
  const res = await api('/admin/properties/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties }),
  });
  const data = await res.json();
  renderCsvResults(data.results, properties);
  loadOrgs();
  loadProperties();
});

(async () => {
  await loadMe();
  await loadOrgs();
  await loadProperties();
  await loadTeam();
})();
