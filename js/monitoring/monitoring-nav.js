const initProfileMenu = () => {
  const profileMenu = document.querySelector('[data-profile-menu]');
  const profileToggle = document.querySelector('[data-profile-toggle]');
  const profileDropdown = profileMenu ? profileMenu.querySelector('.profile-dropdown') : null;

  if (!profileMenu || !profileToggle || !profileDropdown) {
    return;
  }

  const setProfileMenuState = (isOpen) => {
    profileMenu.classList.toggle('open', isOpen);
    profileMenu.classList.toggle('is-active', isOpen);
    profileMenu.classList.toggle('active', isOpen);
    profileDropdown.classList.toggle('show', isOpen);
    profileDropdown.classList.toggle('is-visible', isOpen);
    profileDropdown.classList.toggle('active', isOpen);
    profileToggle.setAttribute('aria-expanded', String(isOpen));
  };

  const closeProfileMenu = () => setProfileMenuState(false);

  function closeProfileMenuOnDocumentClick(event) {
    if (!profileMenu.contains(event.target)) {
      closeProfileMenu();
    }
  }

  function closeProfileMenuOnEscape(event) {
    if (event.key === 'Escape') {
      closeProfileMenu();
    }
  }

  if (!profileToggle.dataset.menuBound) {
    profileToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const isOpen = !profileMenu.classList.contains('open');
      setProfileMenuState(isOpen);
    });
    profileToggle.dataset.menuBound = 'true';
  }

  document.removeEventListener('click', closeProfileMenuOnDocumentClick);
  document.addEventListener('click', closeProfileMenuOnDocumentClick);

  document.removeEventListener('keydown', closeProfileMenuOnEscape);
  document.addEventListener('keydown', closeProfileMenuOnEscape);

  setProfileMenuState(false);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initProfileMenu, { once: true });
} else {
  initProfileMenu();
}