document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const res = await fetch('/org-auth/magic-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await res.json();
  const msg = document.getElementById('loginMessage');
  msg.style.display = 'block';
  msg.innerHTML = `<strong>${data.message}</strong>`;
});
