import { 
    collection, 
    getDocs, 
    doc, 
    deleteDoc, 
    updateDoc, 
    addDoc, 
    serverTimestamp, 
    setDoc 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
    getAuth,
    createUserWithEmailAndPassword,
    signOut,
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

const editUserModal = document.getElementById('editUserModal');
const editUserForm = document.getElementById('editUserForm');
const closeEditModalBtn = document.getElementById('closeEditModalBtn');
const cancelEditBtn = document.getElementById('cancelEditBtn');

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
        const lastActiveText = formatLastActive(user.lastLogin || user.last_active);

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
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);

        newBtn.addEventListener('click', async (e) => {
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
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);

        newBtn.addEventListener('click', (e) => {
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

    if (editUserModal) editUserModal.style.display = 'flex';
}

function closeEditModal() {
    if (editUserModal) editUserModal.style.display = 'none';
    if (editUserForm) editUserForm.reset();
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
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerText = 'Saving...';
    }

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
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerText = 'Save Changes';
        }
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
    if (saveAddBtn) {
        saveAddBtn.disabled = true;
        saveAddBtn.innerText = 'Creating...';
    }

    const firstName = document.getElementById('addFirstname').value.trim();
    const lastName = document.getElementById('addLastname').value.trim();
    const role = document.getElementById('addRole').value;
    const email = createEmail(firstName, lastName);
    const password = createPassword();

    try {
        const userCredential = await createUserWithEmailAndPassword(secondaryAuth, email, password);
        const newUid = userCredential.user.uid;

        await signOut(secondaryAuth);

        const newUserPayload = {
            username: createUsername(firstName, lastName, role),
            firstname: firstName,
            lastname: lastName,
            email_address: email,
            phone_no: document.getElementById('addPhone').value.trim(),
            role: role,
            region: document.getElementById('region-text').value,
            province: document.getElementById('province-text').value,
            city: document.getElementById('city-text').value,
            barangay: document.getElementById('barangay-text').value,
            status: "pending",
            date_joined: serverTimestamp(),
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
        addUserForm.reset();

        showSuccessModal(email, password);

    } catch (err) {
        console.error("Error creating user in Auth/Firestore:", err);
        alert(`Failed to create user: ${err.message}`);
    } finally {
        if (saveAddBtn) {
            saveAddBtn.disabled = false;
            saveAddBtn.innerText = 'Create User';
        }
    }
});

function createPassword() {
    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+~`|}{[]:;?><,./-=";
    let password = "";
    const passwordLength = 12;

    const randomValues = new Uint32Array(passwordLength);

    window.crypto.getRandomValues(randomValues);

    for (let i = 0; i < passwordLength; i++) {
        password += charset[randomValues[i] % charset.length];
    }

    return password;
}

function createEmail(firstName, lastName, domain = "riversight.gov.ph") {
  const cleanFirst = firstName.trim().toLowerCase();
  const cleanLast = lastName.trim().toLowerCase();
  
  const firstNamesArray = cleanFirst.split(/\s+/);
  
  const firstInitials = firstNamesArray.map(name => name[0]).join('');

  const emailUsername = `${firstInitials}${cleanLast}`;
  
  return `${emailUsername}@${domain}`;
}

function createUsername(firstName, lastName, role) {
    const cleanFirst = firstName.trim().toLowerCase();
    const cleanLast = lastName.trim().toLowerCase();

    const firstNamesArray = cleanFirst.split(/\s+/);

    const firstInitials = firstNamesArray.map(name => name[0]).join('');

    return `${firstInitials}${cleanLast}_${role.toLowerCase()}`;
}

function showSuccessModal(email, password) {
    document.getElementById('createdEmailDisplay').value = email;
    document.getElementById('createdPasswordDisplay').value = password;
    
    const copyBtn = document.getElementById('copyPasswordBtn');
    copyBtn.innerText = 'Copy Password';
    
    document.getElementById('userSuccessModal').style.display = 'flex';
}

function closeSuccessModal() {
    document.getElementById('userSuccessModal').style.display = 'none';
}

document.getElementById('closeSuccessModalBtn')?.addEventListener('click', closeSuccessModal);
document.getElementById('doneSuccessBtn')?.addEventListener('click', closeSuccessModal);

document.getElementById('copyPasswordBtn')?.addEventListener('click', async () => {
    const passwordInput = document.getElementById('createdPasswordDisplay');
    const copyBtn = document.getElementById('copyPasswordBtn');

    try {
        await navigator.clipboard.writeText(passwordInput.value);
        copyBtn.innerText = 'Copied!';
        setTimeout(() => {
            copyBtn.innerText = 'Copy Password';
        }, 2500);
    } catch (err) {
        passwordInput.select();
        document.execCommand('copy');
        copyBtn.innerText = 'Copied!';
    }
});

var my_handlers = {
    // fill province
    fill_provinces: function() {
        //selected region
        var region_code = $(this).val();

        // set selected text to input
        var region_text = $(this).find("option:selected").text();
        let region_input = $('#region-text');
        region_input.val(region_text);
        //clear province & city & barangay input
        $('#province-text').val('');
        $('#city-text').val('');
        $('#barangay-text').val('');

        //province
        let dropdown = $('#province');
        dropdown.empty();
        dropdown.append('<option selected="true" disabled>Choose State/Province</option>');
        dropdown.prop('selectedIndex', 0);

        //city
        let city = $('#city');
        city.empty();
        city.append('<option selected="true" disabled></option>');
        city.prop('selectedIndex', 0);

        //barangay
        let barangay = $('#barangay');
        barangay.empty();
        barangay.append('<option selected="true" disabled></option>');
        barangay.prop('selectedIndex', 0);

        // filter & fill
        var url = '../../assets/ph-json/province.json';
        $.getJSON(url, function(data) {
            var result = data.filter(function(value) {
                return value.region_code == region_code;
            });

            result.sort(function(a, b) {
                return a.province_name.localeCompare(b.province_name);
            });

            $.each(result, function(key, entry) {
                dropdown.append($('<option></option>').attr('value', entry.province_code).text(entry.province_name));
            })

        });
    },
    // fill city
    fill_cities: function() {
        //selected province
        var province_code = $(this).val();

        // set selected text to input
        var province_text = $(this).find("option:selected").text();
        let province_input = $('#province-text');
        province_input.val(province_text);
        //clear city & barangay input
        $('#city-text').val('');
        $('#barangay-text').val('');

        //city
        let dropdown = $('#city');
        dropdown.empty();
        dropdown.append('<option selected="true" disabled>Choose city/municipality</option>');
        dropdown.prop('selectedIndex', 0);

        //barangay
        let barangay = $('#barangay');
        barangay.empty();
        barangay.append('<option selected="true" disabled></option>');
        barangay.prop('selectedIndex', 0);

        // filter & fill
        var url = '../../assets/ph-json/city.json';
        $.getJSON(url, function(data) {
            var result = data.filter(function(value) {
                return value.province_code == province_code;
            });

            result.sort(function(a, b) {
                return a.city_name.localeCompare(b.city_name);
            });

            $.each(result, function(key, entry) {
                dropdown.append($('<option></option>').attr('value', entry.city_code).text(entry.city_name));
            })

        });
    },
    // fill barangay
    fill_barangays: function() {
        // selected barangay
        var city_code = $(this).val();

        // set selected text to input
        var city_text = $(this).find("option:selected").text();
        let city_input = $('#city-text');
        city_input.val(city_text);
        //clear barangay input
        $('#barangay-text').val('');

        // barangay
        let dropdown = $('#barangay');
        dropdown.empty();
        dropdown.append('<option selected="true" disabled>Choose barangay</option>');
        dropdown.prop('selectedIndex', 0);

        // filter & Fill
        var url = '../../assets/ph-json/barangay.json';
        $.getJSON(url, function(data) {
            var result = data.filter(function(value) {
                return value.city_code == city_code;
            });

            result.sort(function(a, b) {
                return a.brgy_name.localeCompare(b.brgy_name);
            });

            $.each(result, function(key, entry) {
                dropdown.append($('<option></option>').attr('value', entry.brgy_code).text(entry.brgy_name));
            })

        });
    },

    onchange_barangay: function() {
        // set selected text to input
        var barangay_text = $(this).find("option:selected").text();
        let barangay_input = $('#barangay-text');
        barangay_input.val(barangay_text);
    },

};


$(function() {
    // events
    $('#region').on('change', my_handlers.fill_provinces);
    $('#province').on('change', my_handlers.fill_cities);
    $('#city').on('change', my_handlers.fill_barangays);
    $('#barangay').on('change', my_handlers.onchange_barangay);

    // load region
    let dropdown = $('#region');
    dropdown.empty();
    dropdown.append('<option selected="true" disabled>Choose Region</option>');
    dropdown.prop('selectedIndex', 0);
    const url = '../../assets/ph-json/region.json';
    // Populate dropdown with list of regions
    $.getJSON(url, function(data) {
        $.each(data, function(key, entry) {
            dropdown.append($('<option></option>').attr('value', entry.region_code).text(entry.region_name));
        })
    });

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