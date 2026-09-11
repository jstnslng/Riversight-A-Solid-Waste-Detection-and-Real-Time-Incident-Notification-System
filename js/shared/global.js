import { auth } from './firebase-config.js';
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { initNotifications } from "./notifications.js";

document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('js-ready');

  // --- 1. Firebase Logout Handler ---
  document.querySelectorAll('[data-logout-link]').forEach((link) => {
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      try {
        await signOut(auth);
      } catch (error) {
        console.error('Error signing out of Firebase:', error);
      }
      sessionStorage.clear();
      localStorage.clear();
      window.location.href = link.dataset.logoutTarget || '../../lib/admin/Admin-Login.html';
    });
  });

  initNotifications();

  // --- 3. Profile Dropdown Menu Toggle ---
  const profileToggle = document.querySelector('[data-profile-toggle]');
  const profileDropdown = document.querySelector('.profile-dropdown');

  if (profileToggle && profileDropdown) {
    profileToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      notificationDropdown?.classList.remove('show');
      profileDropdown.classList.toggle('show');
    });

    document.addEventListener('click', (event) => {
      if (!profileToggle.contains(event.target) && !profileDropdown.contains(event.target)) {
        profileDropdown.classList.remove('show');
      }
    });
  }
});