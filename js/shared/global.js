import { auth, db } from './firebase-config.js';
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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

  // --- 2. Notification Bell Menu Toggle ---
  const notificationToggle = document.getElementById('notificationToggle');
  const notificationDropdown = document.getElementById('notificationDropdown');

  if (notificationToggle && notificationDropdown) {
    notificationToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      document.querySelector('.profile-dropdown')?.classList.remove('show');
      notificationDropdown.classList.toggle('show');
    });

    document.addEventListener('click', (event) => {
      if (!notificationToggle.contains(event.target) && !notificationDropdown.contains(event.target)) {
        notificationDropdown.classList.remove('show');
      }
    });

    initHeaderNotifications();
  }

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

/**
 * Real-time listener for header notification badge and items (reading from 'reports')
 */
function initHeaderNotifications() {
  const dropdownBody = document.querySelector('#notificationDropdown .dropdown-body');
  const badge = document.querySelector('#notificationToggle .badge');

  onSnapshot(collection(db, 'reports'), (snapshot) => {
    const reports = snapshot.docs.map(doc => ({
      docId: doc.id,
      ...doc.data()
    }));

    // Active (unresolved) reports
    const activeAlerts = reports.filter(r => r.status !== 'Resolved');

    // Update Badge
    if (badge) {
      badge.textContent = activeAlerts.length;
      badge.style.display = activeAlerts.length > 0 ? 'flex' : 'none';
    }

    // Update Dropdown List
    if (dropdownBody) {
      if (activeAlerts.length === 0) {
        dropdownBody.innerHTML = `
          <div style="padding: 16px; font-size: 12px; color: var(--muted); text-align: center;">
            No active alerts
          </div>`;
        return;
      }

      dropdownBody.innerHTML = activeAlerts.slice(0, 5).map(item => {
        const displayTime = item.timestamp || item.dateText || '';
        const isCritical = item.severity === 'CRITICAL' || item.severity === 'HIGH';

        return `
          <a href="./Incident-Reports.html" class="report-item">
            <div class="report-title">
              <span class="${isCritical ? 'critical' : 'info'}">${item.severity || 'ALERT'}: ${item.reportId || item.docId}</span>
              <span class="time">${displayTime}</span>
            </div>
            <div class="report-desc">${item.detectionType || 'Waste activity'} — ${item.location || 'Location N/A'}</div>
          </a>
        `;
      }).join('');
    }
  }, (error) => {
    console.error("Firestore Notification Error:", error);
  });
}