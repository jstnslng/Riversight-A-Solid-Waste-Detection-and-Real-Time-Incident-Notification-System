document.addEventListener('DOMContentLoaded', () => {
  const profileMenu = document.querySelector('[data-profile-menu]');
  const profileToggle = document.querySelector('[data-profile-toggle]');

  if (!profileMenu || !profileToggle) {
    return;
  }

  const closeProfileMenu = () => {
    profileMenu.classList.remove('open');
    profileToggle.setAttribute('aria-expanded', 'false');
  };

  profileToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    const isOpen = profileMenu.classList.toggle('open');
    profileToggle.setAttribute('aria-expanded', String(isOpen));
  });

  document.addEventListener('click', (event) => {
    if (!profileMenu.contains(event.target)) {
      closeProfileMenu();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeProfileMenu();
    }
  });
});