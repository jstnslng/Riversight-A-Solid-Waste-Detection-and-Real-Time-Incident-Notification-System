import { doc, getDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { auth, db } from "../shared/firebase-config.js";

const loadingOverlay = document.getElementById('loadingOverlay');
const mainContent = document.getElementById('profileMain');

const fullNameInput = document.querySelector('input[placeholder="Full Name"]');
const usernameInput = document.querySelector('input[placeholder="Username"]');
const emailInput = document.querySelector('input[placeholder="Email Address"]');
const phoneInput = document.querySelector('input[placeholder="Phone Number"]');
const roleInput = document.querySelector('input[value="System Administrator"]');
const stationInput = document.querySelector('input[value="PH-MNL-QC"]');

const heroName = document.querySelector('.profile-summary h2');
const heroRole = document.querySelector('.profile-summary .card-sub');
const heroStation = document.querySelector('.profile-summary .meta-line');
const headerName = document.querySelector('.user-name');
const headerRole = document.querySelector('.user-role');
const userIdPill = document.querySelector('.pill-red');
const userIdDisplay = document.querySelectorAll('.info-item strong')[1];
const dateJoinedDisplay = document.querySelectorAll('.info-item strong')[2];
const lastLoginDisplay = document.querySelectorAll('.info-item strong')[3];

const editButton = document.querySelector('[data-edit-profile]');
const saveButton = document.querySelector('[data-save-profile]');
const cancelButton = document.querySelector('[data-cancel-profile]');
const logoutLink = document.querySelector('[data-logout-link]');

const profileMenu = document.querySelector('[data-profile-menu]');
const profileToggle = document.querySelector('[data-profile-toggle]');

let currentUserRef = null;
let originalValues = [];

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

        fullNameInput.value = data.fullname || '';
        usernameInput.value = data.username || '';
        emailInput.value = data.email_address || user.email || '';
        phoneInput.value = data.phone_no || '';
        roleInput.value = data.role || '';
        stationInput.value = data.assigned_station || '';

        heroName.textContent = data.fullname || '';
        heroRole.textContent = data.role || '';
        heroStation.textContent = `Assigned monitoring station: ${data.assigned_station || ''}`;
        headerName.textContent = data.fullname || '';
        headerRole.textContent = data.role || '';

        if (userIdPill) userIdPill.textContent = `User ID: ${user.uid.substring(0, 8)}`;
        if (userIdDisplay) userIdDisplay.textContent = user.uid.substring(0, 8);
        if (dateJoinedDisplay) dateJoinedDisplay.textContent = formatTimestamp(data.date_joined);
        if (lastLoginDisplay) lastLoginDisplay.textContent = formatTimestamp(data.last_login);

        originalValues = [
            fullNameInput.value,
            usernameInput.value,
            emailInput.value,
            phoneInput.value
        ];

        if (loadingOverlay) loadingOverlay.style.display = 'none';
        if (mainContent) mainContent.style.display = 'block';

    } catch (error) {
        console.error("Failed to load user profile:", error);
        alert("Error loading profile data.");
    }
});

function setEditingState(isEditing) {
    [fullNameInput, usernameInput, emailInput, phoneInput].forEach(field => {
        field.disabled = !isEditing;
    });

    editButton.style.display = isEditing ? 'none' : '';
    saveButton.hidden = !isEditing;
    cancelButton.hidden = !isEditing;
}

editButton.addEventListener('click', () => setEditingState(true));

cancelButton.addEventListener('click', () => {
    [fullNameInput.value, usernameInput.value, emailInput.value, phoneInput.value] = originalValues;
    setEditingState(false);
});

saveButton.addEventListener('click', async () => {
    if (!currentUserRef) return;

    saveButton.disabled = true;
    saveButton.textContent = 'Saving...';

    try {
        const updatedData = {
            fullname: fullNameInput.value.trim(),
            username: usernameInput.value.trim(),
            email_address: emailInput.value.trim(),
            phone_no: phoneInput.value.trim()
        };

        await updateDoc(currentUserRef, updatedData);

        originalValues = [updatedData.fullname, updatedData.username, updatedData.email_address, updatedData.phone_no];
        heroName.textContent = updatedData.fullname;
        headerName.textContent = updatedData.fullname;

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