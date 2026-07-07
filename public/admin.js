let myRole = null;
let orgs = [];

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
  document.getElementById('whoami').textContent = myRole === 'super_admin' ? 'Admin (Super Admin)' : 'Admin (Install Staff)';
  document.getElementById('teamCard').style.display = myRole === 'super_admin' ? 'block' : 'none';
}

async function loadOrgs() {
  const res = await api('/admin/organizations');
  const data = await res.json();
  orgs = data.organizations;

  const tbody = document.getElementById('orgsBody');
  tbody.innerHTML = '';
  const typeLabels = { HA: 'Housing Association', LA: 'Local Authority', other: 'Other' };
  orgs.forEach((o) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${o.name}</td><td>${typeLabels[o.type] || o.type}</td><td>${o.property_count}</td>`;
    tbody.appendChild(tr);
  });

  [document.getElementById('propertyOrg'), document.getElementById('orgFilter'), document.getElementById('orgUserOrg')].forEach((select) => {
    const keep = select.id === 'orgFilter' ? select.value : '';
    const placeholder = select.id === 'orgFilter' ? '<option value="">All organizations</option>' : select.id === 'propertyOrg' ? '<option value="">— None —</option>' : '';
    select.innerHTML = placeholder + orgs.map((o) => `<option value="${o.id}">${o.name}</option>`).join('');
    if (keep) select.value = keep;
  });
}

function renderPropertyRow(p) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${p.id}</td>
    <td>${p.address}</td>
    <td>${p.tenant_name}</td>
    <td>${p.fox_device_sn}</td>
    <td><code>${p.signup_code || '—'}</code></td>
    <td>${p.tenant_email || '—'}</td>
    <td>${p.has_fox_token ? '✓' : '—'}</td>
    <td>${p.last_reading_at ? new Date(p.last_reading_at).toLocaleString('en-GB') : 'never'}</td>
    <td>${p.last_rollup_date || 'never'}</td>
    <td><a href="/oauth/fox/authorize?propertyId=${p.id}" target="_blank">Fox consent link</a></td>
  `;
  return tr;
}

const PROPERTY_COLUMNS = ['ID', 'Address', 'Tenant', 'Device SN', 'Signup code', 'Email', 'Fox linked', 'Last reading', 'Last rollup', ''];

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
    tr.innerHTML = `
      <td>${t.name}</td>
      <td>${t.email}</td>
      <td><span class="hint">${t.role === 'super_admin' ? 'Super Admin' : 'Install Staff'}</span></td>
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

(async () => {
  await loadMe();
  await loadOrgs();
  await loadProperties();
  await loadTeam();
})();
