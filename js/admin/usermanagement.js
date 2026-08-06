import { collection, getDocs, doc, deleteDoc, updateDoc, addDoc, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
    getAuth,
    createUserWithEmailAndPassword,
    signOut as authSignOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { auth, db, firebaseConfig } from "../shared/firebase-config.js";

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

const addUserBtn = document.getElementById('addUserBtn');
const addUserModal = document.getElementById('addUserModal');
const addUserForm = document.getElementById('addUserForm');
const closeAddModalBtn = document.getElementById('closeAddModalBtn');
const cancelAddBtn = document.getElementById('cancelAddBtn');

const statusFilterSelect = document.getElementById('statusFilterSelect');
const roleFilterSelect = document.getElementById('roleFilterSelect');
const barangayFilterSelect = document.getElementById('barangayFilterSelect');

const secondaryApp = initializeApp(firebaseConfig, "SecondaryAuthApp");
const secondaryAuth = getAuth(secondaryApp);

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
    if (r.includes('monitoring')) return 'monitoring';
    return 'monitoring';
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
    const searchQuery = (globalSearchInput?.value || '').toLowerCase().trim();
    const selectedStatus = (statusFilterSelect?.value || 'all').toLowerCase();
    const selectedRole = (roleFilterSelect?.value || 'all').toLowerCase();
    const selectedBarangay = (barangayFilterSelect?.value || 'all').toLowerCase();

    const filteredUsers = allUsersData.filter(user => {
        const userStatus = (user.status || 'active').toLowerCase();
        const statusMatch = (selectedStatus === 'all') || (userStatus === selectedStatus);

        const userRole = (user.role || '').toLowerCase();
        const roleMatch = (selectedRole === 'all') || userRole.includes(selectedRole);

        const userBarangay = (user.barangay || '').toLowerCase();
        const userStation = (user.assigned_station || '').toLowerCase();
        const barangayMatch = (selectedBarangay === 'all') ||
            userBarangay.includes(selectedBarangay) ||
            userStation.includes(selectedBarangay);

        const name = (user.fullname || '').toLowerCase();
        const email = (user.email_address || user.email || '').toLowerCase();
        const username = (user.username || '').toLowerCase();

        const searchMatch = !searchQuery ||
            name.includes(searchQuery) ||
            email.includes(searchQuery) ||
            username.includes(searchQuery) ||
            userBarangay.includes(searchQuery) ||
            userStation.includes(searchQuery) ||
            userRole.includes(searchQuery);

        return statusMatch && roleMatch && barangayMatch && searchMatch;
    });

    renderUsersTable(filteredUsers);
}

statusFilterSelect?.addEventListener('change', applyFilters);
roleFilterSelect?.addEventListener('change', applyFilters);
barangayFilterSelect?.addEventListener('change', applyFilters);
globalSearchInput?.addEventListener('input', applyFilters);

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
            const targetUser = allUsersData.find(u => u.id === userId);
            if (targetUser) openEditModal(targetUser);
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

function openEditModal(user) {
    document.getElementById('editUserId').value = user.id;
    document.getElementById('editUsername').value = user.username || '';
    document.getElementById('editFullname').value = user.fullname || '';
    document.getElementById('editEmail').value = user.email_address || user.email || '';
    document.getElementById('editPhone').value = user.phone_no || '';
    document.getElementById('editBarangay').value = user.barangay || 'Bagumbuhay';
    document.getElementById('editStatus').value = (user.status || 'active').toLowerCase();
    document.getElementById('editAssignedStation').value = user.assigned_station || 'PH-MNL-QC';

    editUserModal.style.display = 'flex';
}

function closeEditModal() {
    editUserModal.style.display = 'none';
    editUserForm.reset();
}

editUserForm?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const userId = document.getElementById('editUserId').value;
    const updatedPayload = {
        username: document.getElementById('editUsername').value.trim(),
        fullname: document.getElementById('editFullname').value.trim(),
        email_address: document.getElementById('editEmail').value.trim(),
        phone_no: document.getElementById('editPhone').value.trim(),
        barangay: document.getElementById('editBarangay').value,
        status: document.getElementById('editStatus').value,
        assigned_station: document.getElementById('editAssignedStation').value,
        updated_at: serverTimestamp()
    };

    const saveBtn = document.getElementById('saveEditBtn');
    saveBtn.disabled = true;
    saveBtn.innerText = 'Saving...';

    try {
        const userDocRef = doc(db, "users", userId);
        await updateDoc(userDocRef, updatedPayload);

        const index = allUsersData.findIndex(u => u.id === userId);
        if (index !== -1) {
            allUsersData[index] = { ...allUsersData[index], ...updatedPayload };
        }

        updateStats(allUsersData);
        applyFilters();
        closeEditModal();
    } catch (err) {
        console.error("Error updating user document:", err);
        alert("Failed to update user record.");
    } finally {
        saveBtn.disabled = false;
        saveBtn.innerText = 'Save Changes';
    }
});

closeEditModalBtn?.addEventListener('click', closeEditModal);
cancelEditBtn?.addEventListener('click', closeEditModal);

function openAddModal() {
    if (addUserModal) addUserModal.style.display = 'flex';
}

function closeAddModal() {
    if (addUserModal) {
        addUserModal.style.display = 'none';
        addUserForm.reset();
    }
}

addUserBtn?.addEventListener('click', openAddModal);
closeAddModalBtn?.addEventListener('click', closeAddModal);
cancelAddBtn?.addEventListener('click', closeAddModal);

addUserForm?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const saveAddBtn = document.getElementById('saveAddBtn');
    saveAddBtn.disabled = true;
    saveAddBtn.innerText = 'Creating...';

    const email = document.getElementById('addEmail').value.trim();
    const password = document.getElementById('addPassword').value;

    try {
        const userCredential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
        const newUid = userCredential.user.uid;

        await authSignOut(secondaryAuth);

        const newUserPayload = {
            username: document.getElementById('addUsername').value.trim(),
            fullname: document.getElementById('addFullname').value.trim(),
            email_address: email,
            phone_no: document.getElementById('addPhone').value.trim(),
            role: document.getElementById('addRole').value,
            barangay: document.getElementById('addBarangay').value,
            status: document.getElementById('addStatus').value,
            assigned_station: document.getElementById('addAssignedStation').value,
            created_at: serverTimestamp(),
            last_login: null
        };

        await setDoc(doc(db, "users", newUid), newUserPayload);

        allUsersData.unshift({
            id: newUid,
            ...newUserPayload
        });

        updateStats(allUsersData);
        applyFilters();
        closeAddModal();
        alert("User account successfully created!");

    } catch (err) {
        console.error("Error creating user in Auth/Firestore:", err);
        alert(`Failed to create user: ${err.message}`);
    } finally {
        saveAddBtn.disabled = false;
        saveAddBtn.innerText = 'Create User';
    }
});

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