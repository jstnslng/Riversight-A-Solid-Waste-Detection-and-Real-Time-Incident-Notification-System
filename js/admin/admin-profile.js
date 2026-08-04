import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { auth, db } from "../shared/firebase-config.js";

const loadingOverlay = document.getElementById('loadingOverlay');
const mainContent = document.getElementById('profileMain');

const usernameInput = document.querySelector('input[placeholder="Username"]');
const emailInput = document.querySelector('input[placeholder="Email Address"]');
const phoneInput = document.querySelector('input[placeholder="Phone Number"]');

const heroName = document.querySelector('.profile-summary h2');
const heroStatus = document.querySelector('[data-profile-status]');
const heroRole = document.querySelector('[data-profile-role]');
const heroStation = document.querySelector('[data-profile-station]');
const heroLastLogin = document.querySelector('[data-profile-last-login]');
const headerName = document.querySelector('.user-name');
const headerRole = document.querySelector('.user-role');
const userIdDisplay = document.querySelector('[data-profile-user-id]');
const dateJoinedDisplay = document.querySelector('[data-profile-date-joined]');

const editButton = document.querySelector('[data-edit-profile]');
const saveButton = document.querySelector('[data-save-profile]');
const cancelButton = document.querySelector('[data-cancel-profile]');
const logoutLink = document.querySelector('[data-logout-link]');

const profileMenu = document.querySelector('[data-profile-menu]');
const profileToggle = document.querySelector('[data-profile-toggle]');

let currentUserRef = null;
let originalValues = [];
const editableFields = [usernameInput, emailInput, phoneInput].filter(Boolean);

function formatTimestamp(timestamp) {
    if (!timestamp) return 'N/A';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
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
        if (!profileMenu.contains(e.target)) {
            closeProfileMenu();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeProfileMenu();
        }
    });
}

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = './Admin-Login.html';
        return;
    }

    try {
        currentUserRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(currentUserRef);

        if (!userSnap.exists()) {
            alert("No account profile found in Firestore.");
            await signOut(auth);
            window.location.href = './Admin-Login.html';
            return;
        }

        const data = userSnap.data();

        if (data.role !== "Administrator") {
            alert("Unauthorized access.");
            await signOut(auth);
            window.location.href = './Admin-Login.html';
            return;
        }

        usernameInput.value = data.username || '';
        emailInput.value = data.email_address || user.email || '';
        phoneInput.value = data.phone_no || '';

        const accountStatus = data.status || 'Active';
        const fullName = data.fullname || 'Administrator';
        const role = data.role || 'System Administrator';
        const assignedStation = data.assigned_station || 'PH-MNL-QC';

        if (heroStatus) heroStatus.textContent = accountStatus;
        heroName.textContent = fullName;
        if (heroRole) heroRole.textContent = role;
        if (heroStation) heroStation.textContent = `Assigned monitoring station: ${assignedStation}`;
        if (heroLastLogin) heroLastLogin.textContent = `Last login: ${formatTimestamp(data.last_login)}`;
        headerName.textContent = fullName;
        headerRole.textContent = role;

        if (userIdDisplay) userIdDisplay.textContent = user.uid.substring(0, 8);
        if (dateJoinedDisplay) dateJoinedDisplay.textContent = formatTimestamp(data.date_joined);

        originalValues = editableFields.map(field => field.value);

        if (loadingOverlay) loadingOverlay.style.display = 'none';
        if (mainContent) mainContent.style.display = 'block';

    } catch (error) {
        console.error("Failed to load user profile:", error);
        alert("Error loading profile data.");
    }
});

function setEditingState(isEditing) {
    editableFields.forEach(field => {
        field.disabled = !isEditing;
    });

    editButton.style.display = isEditing ? 'none' : '';
    saveButton.hidden = !isEditing;
    cancelButton.hidden = !isEditing;
}

editButton.addEventListener('click', () => setEditingState(true));

cancelButton.addEventListener('click', () => {
    editableFields.forEach((field, index) => {
        field.value = originalValues[index] || '';
    });
    setEditingState(false);
});

saveButton.addEventListener('click', async () => {
    if (!currentUserRef) return;

    saveButton.disabled = true;
    saveButton.textContent = 'Saving...';

    try {
        const updatedData = {
            username: usernameInput.value.trim(),
            email_address: emailInput.value.trim(),
            phone_no: phoneInput.value.trim()
        };

        await updateDoc(currentUserRef, updatedData);

        originalValues = editableFields.map(field => field.value);

        setEditingState(false);
    } catch (error) {
        console.error("Error updating profile:", error);
        alert("Failed to update profile changes.");
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = 'Save Changes';
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
            console.error("Sign out error:", err);
        } finally {
            window.location.href = './Admin-Login.html';
        }
    });
}