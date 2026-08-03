import { collection, getDocs, doc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { auth, db } from "../shared/firebase-config.js";

const loadingOverlay = document.getElementById('loadingOverlay');
const mainContent = document.getElementById('usermanagement-Main');

const userTableBody = document.querySelector('#userTable tbody');
const toggles = document.querySelectorAll('.table-toggles .toggle-pill');
const globalSearchInput = document.querySelector('.search-wrap input');

const profileMenu = document.querySelector('[data-profile-menu]');
const profileToggle = document.querySelector('[data-profile-toggle]');
const logoutLink = document.querySelector('[data-logout-link]');
const headerName = document.querySelector('.user-name');
const headerRole = document.querySelector('.user-role');

const totalUsersStat = document.querySelectorAll('.stat-value')[0];
const activeNowStat = document.querySelectorAll('.stat-value')[1];
const adminsStat = document.querySelectorAll('.stat-value')[2];
const pendingStat = document.querySelectorAll('.stat-value')[3];
const totalAccountsSub = document.querySelector('.updated-row');

let allUsersData = [];
let currentFilter = 'all';

function getInitials(name = '') {
    const parts = name.trim().split(' ').filter(Boolean);
    if (parts.length === 0) return 'U';
    if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatLastActive(timestamp) {
    if (!timestamp) return 'Never';
    const date = typeof timestamp.toDate === 'function' ? timestamp.toDate() : new Date(timestamp);
    if (isNaN(date.getTime())) return 'Never';

    const diffInSeconds = Math.floor((new Date() - date) / 1000);
    if (diffInSeconds < 60) return 'Just now';
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} mins ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} hours ago`;
    if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)} days ago`;

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getRoleBadgeClass(role = '') {
    const r = role.toLowerCase();
    if (r.includes('admin')) return 'admin';
    if (r.includes('operator')) return 'operator';
    return 'operator';
}

function renderUsersTable(usersToRender) {
    userTableBody.innerHTML = '';

    if (usersToRender.length === 0) {
        userTableBody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align: center; padding: 24px; color: var(--text-muted, #64748b);">
                    No users found matching your criteria.
                </td>
            </tr>
        `;
        return;
    }

    usersToRender.forEach(user => {
        const tr = document.createElement('tr');
        const statusKey = (user.status || 'active').toLowerCase();
        tr.setAttribute('data-status', statusKey);

        const initials = getInitials(user.fullname || user.name);
        const roleClass = getRoleBadgeClass(user.role);
        const lastActiveText = formatLastActive(user.last_login || user.last_active);

        tr.innerHTML = `
            <td class="user-cell">
                <span class="avatar-circle">${initials}</span>
                <div>
                    <div class="u-name">${user.fullname || 'Unnamed User'}</div>
                    <div class="u-email">${user.email_address || user.email || 'No Email'}</div>
                </div>
            </td>
            <td><span class="role-badge ${roleClass}">${user.role || 'User'}</span></td>
            <td>${user.barangay || 'Unassigned'}</td>
            <td><span class="status-badge ${statusKey}">${user.status || 'Active'}</span></td>
            <td>${lastActiveText}</td>
            <td class="actions-cell">
                <button class="row-icon-btn edit-user-btn" data-id="${user.id}" title="Edit">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/></svg>
                </button>
                <button class="row-icon-btn danger delete-user-btn" data-id="${user.id}" title="Remove">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
                </button>
            </td>
        `;
        userTableBody.appendChild(tr);
    });

    attachRowActionListeners();
}

function updateStats(users) {
    const total = users.length;
    const active = users.filter(u => (u.status || 'active').toLowerCase() === 'active').length;
    const admins = users.filter(u => (u.role || '').toLowerCase().includes('admin')).length;
    const pending = users.filter(u => (u.status || '').toLowerCase() === 'pending').length;

    if (totalUsersStat) totalUsersStat.childNodes[0].nodeValue = `${total} `;
    if (activeNowStat) activeNowStat.childNodes[0].nodeValue = `${active} `;
    if (adminsStat) adminsStat.childNodes[0].nodeValue = `${admins} `;
    if (pendingStat) pendingStat.childNodes[0].nodeValue = `${pending} `;
    if (totalAccountsSub) totalAccountsSub.innerHTML = `<span class="live-dot"></span> ${total} registered accounts`;
}

function applyFilters() {
    const query = (globalSearchInput?.value || '').toLowerCase().trim();

    const filtered = allUsersData.filter(user => {
        const statusMatch = currentFilter === 'all' || (user.status || 'active').toLowerCase() === currentFilter;

        const name = (user.fullname || '').toLowerCase();
        const email = (user.email_address || user.email || '').toLowerCase();
        const sector = (user.assigned_station || user.assigned_sector || '').toLowerCase();
        const role = (user.role || '').toLowerCase();

        const searchMatch = !query || name.includes(query) || email.includes(query) || sector.includes(query) || role.includes(query);

        return statusMatch && searchMatch;
    });

    renderUsersTable(filtered);
}

async function fetchUsers() {
    try {
        const querySnapshot = await getDocs(collection(db, "users"));
        allUsersData = [];

        querySnapshot.forEach((docSnap) => {
            allUsersData.push({ id: docSnap.id, ...docSnap.data() });
        });

        updateStats(allUsersData);
        applyFilters();

        if (loadingOverlay) loadingOverlay.style.display = 'none';
        if (mainContent) mainContent.style.display = 'block';
    } catch (error) {
        console.error("Error fetching users:", error);
        userTableBody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align: center; color: var(--danger, #ef4444); padding: 20px;">
                    Failed to load user records from database.
                </td>
            </tr>
        `;
    }
}

function attachRowActionListeners() {
    document.querySelectorAll('.delete-user-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const userId = e.currentTarget.dataset.id;
            if (confirm("Are you sure you want to remove this user from Firestore?")) {
                try {
                    await deleteDoc(doc(db, "users", userId));
                    allUsersData = allUsersData.filter(u => u.id !== userId);
                    updateStats(allUsersData);
                    applyFilters();
                } catch (err) {
                    console.error("Failed to delete user:", err);
                    alert("Failed to delete user record.");
                }
            }
        });
    });

    document.querySelectorAll('.edit-user-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const userId = e.currentTarget.dataset.id;
            alert(`Edit user modal/action triggered for ID: ${userId}`);
        });
    });
}

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = './Admin-Login.html';
        return;
    }

    await fetchUsers();
});

toggles.forEach(btn => {
    btn.addEventListener('click', () => {
        toggles.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        applyFilters();
    });
});

if (globalSearchInput) {
    globalSearchInput.addEventListener('input', applyFilters);
}

document.getElementById('addUserBtn')?.addEventListener('click', () => {
    alert('Trigger Add User Modal / Navigation');
});

const closeProfileMenu = () => {
    if (profileMenu && profileToggle) {
        profileMenu.classList.remove('open');
        profileToggle.setAttribute('aria-expanded', 'false');
    }
};

if (profileToggle && profileMenu) {
    profileToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = profileMenu.classList.toggle('open');
        profileToggle.setAttribute('aria-expanded', String(isOpen));
    });

    document.addEventListener('click', (e) => {
        if (!profileMenu.contains(e.target)) closeProfileMenu();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeProfileMenu();
    });
}

if (logoutLink) {
    logoutLink.addEventListener('click', async (e) => {
        e.preventDefault();
        sessionStorage.removeItem('riversightAdminSession');
        localStorage.removeItem('riversightAdminSession');
        try {
            await signOut(auth);
        } catch (err) {
            console.error("Logout error:", err);
        } finally {
            window.location.href = './Admin-Login.html';
        }
    });
}