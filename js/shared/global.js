document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('js-ready');

  document.querySelectorAll('[data-logout-link]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      sessionStorage.clear();
      localStorage.clear();
      window.location.href = link.dataset.logoutTarget || '../../lib/admin/Admin-Login.html';
    });
  });
});
