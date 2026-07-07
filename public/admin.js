let myRole = null;

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

async function loadProperties() {
  const res = await api('/admin/properties');
  const data = await res.json();
  const tbody = document.getElementById('propertiesBody');
  tbody.innerHTML = '';
  data.properties.forEach((p) => {
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
    tbody.appendChild(tr);
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

document.getElementById('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    address: document.getElementById('address').value,
    tenantName: document.getElementById('tenantName').value,
    foxDeviceSn: document.getElementById('foxDeviceSn').value,
    tenantEmail: document.getElementById('tenantEmail').value || undefined,
    arraySizeKwp: document.getElementById('arraySizeKwp').value ? Number(document.getElementById('arraySizeKwp').value) : undefined,
    batteryCapacityKwh: document.getElementById('batteryCapacityKwh').value ? Number(document.getElementById('batteryCapacityKwh').value) : undefined,
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
  await loadProperties();
  await loadTeam();
})();
