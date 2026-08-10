import { doc, getDoc, updateDoc, addDoc, collection } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { auth, db } from "../shared/firebase-config.js";

const displayNameInput = document.getElementById('displayNameInput');
const emailInput = document.getElementById('emailInput');
const phoneInput = document.getElementById('phoneInput');
const roleOutput = document.getElementById('roleOutput');
const stationOutput = document.getElementById('stationOutput');
const lastLoginOutput = document.getElementById('lastLoginOutput');
const userIdOutput = document.getElementById('userIdOutput');

const editButton = document.querySelector('[data-edit-profile]');
const saveButton = document.querySelector('[data-save-profile]');
const cancelButton = document.querySelector('[data-cancel-profile]');

let currentUserRef = null;
let currentUserRole = 'Monitoring Personnel';
let originalValues = [];
const editableFields = [displayNameInput, emailInput, phoneInput].filter(Boolean);

function formatTimestamp(timestamp) {
    if (!timestamp) return 'N/A';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    if (isNaN(date.getTime())) return 'N/A';
    
    return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = './Monitoring-Login.html';
        return;
    }

    try {
        currentUserRef = doc(db, "users", user.uid);
        const userDoc = await getDoc(currentUserRef);

        const data = userDoc.exists() ? userDoc.data() : {};

        currentUserRole = data.role || 'Monitoring Personnel';

        displayNameInput.value = data.username || data.fullname || user.displayName || '';
        emailInput.value = data.email_address || data.email || user.email || '';
        phoneInput.value = data.phone_no || data.phoneNumber || user.phoneNumber || '';

        if (roleOutput) roleOutput.textContent = currentUserRole;
        if (stationOutput) stationOutput.textContent = data.assigned_station || data.station || 'PH-MNL-QC';
        if (lastLoginOutput) lastLoginOutput.textContent = formatTimestamp(data.last_login || user.metadata?.lastSignInTime);
        if (userIdOutput) userIdOutput.textContent = user.uid || 'N/A';

        originalValues = [displayNameInput.value, emailInput.value, phoneInput.value];

    } catch (error) {
        console.error("Error fetching user data:", error);
    }
});

function enableEditing() {
    editableFields.forEach(field => {
        field.disabled = false;
        field.classList.add('editable');
    });

    if (editButton) editButton.hidden = true;
    if (saveButton) saveButton.hidden = false;
    if (cancelButton) cancelButton.hidden = false;
}

function disableEditing() {
    editableFields.forEach(field => {
        field.disabled = true;
        field.classList.remove('editable');
    });

    if (editButton) editButton.hidden = false;
    if (saveButton) saveButton.hidden = true;
    if (cancelButton) cancelButton.hidden = true;
}

if (editButton) editButton.addEventListener('click', enableEditing);

if (cancelButton) {
    cancelButton.addEventListener('click', () => {
        editableFields.forEach((field, index) => {
            field.value = originalValues[index] || '';
        });
        disableEditing();
    });
}

if (saveButton) {
    saveButton.addEventListener('click', async () => {
        if (!currentUserRef) return;

        saveButton.disabled = true;
        saveButton.textContent = 'Saving...';

        const updatedData = {
            username: displayNameInput.value.trim(),
            email_address: emailInput.value.trim(),
            phone_no: phoneInput.value.trim()
        };

        try {
            await updateDoc(currentUserRef, updatedData);

            originalValues = [displayNameInput.value, emailInput.value, phoneInput.value];
            disableEditing();

            const auditEntry = {
                timestamp: new Date(),
                username: updatedData.username || 'Unknown User',
                userId: auth.currentUser?.uid || 'N/A',
                role: currentUserRole,
                action: 'update',
                target: 'Profile',
                details: `Profile updated by ${updatedData.username || 'Unknown User'}.`,
                status: 'success'
            };

            await addDoc(collection(db, "audit"), auditEntry);

        } catch (error) {
            console.error("Error updating profile:", error);
            await addDoc(collection(db, "audit"), {
                timestamp: new Date(),
                username: displayNameInput.value.trim() || 'Unknown User',
                userId: auth.currentUser?.uid || 'N/A',
                role: currentUserRole,
                action: 'update',
                target: 'Profile',
                details: `Failed to update profile for ${displayNameInput.value.trim() || 'Unknown User'}. Error: ${error.message}`,
                status: 'failed'
            });
            alert("Failed to save profile changes.");
        } finally {
            saveButton.disabled = false;
            saveButton.textContent = 'Save Changes';
        }
    });
}