import { doc, getDoc, updateDoc, addDoc, collection } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged, signOut, updatePassword, reauthenticateWithCredential, EmailAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
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

const changePasswordForm = document.getElementById('changePasswordForm');
const updatePasswordBtn = document.getElementById('updatePasswordBtn');

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

        if (!userDoc.exists()) {
            alert("No account profile found in Firestore.");
            await signOut(auth);
            window.location.href = './Monitoring-Login.html';
            return;
        }

        const data = userDoc.exists() ? userDoc.data() : {};

        if (data.role?.toLowerCase() !== "monitoring") {
            alert("Unauthorized access.");
            await signOut(auth);
            window.location.href = './Monitoring-Login.html';
            return;
        }

        currentUserRole = data.role || 'Monitoring Personnel';

        displayNameInput.value = data.username || data.fullname || user.displayName || '';
        emailInput.value = data.email_address || data.email || user.email || '';
        phoneInput.value = data.phone_no || data.phoneNumber || user.phoneNumber || '';

        if (roleOutput) roleOutput.textContent = currentUserRole;
        if (stationOutput) stationOutput.textContent = `${data.city || 'N/A'}, Brgy. ${data.barangay || 'N/A'}`;
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

if (changePasswordForm) {
    changePasswordForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const currentPassword = document.getElementById('currentPassword').value;
        const newPassword = document.getElementById('newPassword').value;
        const confirmPassword = document.getElementById('confirmPassword').value;
        const user = auth.currentUser;

        if (!user || !user.email) {
            alert("No authenticated user found. Please log in again.");
            return;
        }

        if (newPassword !== confirmPassword) {
            alert("New password and confirm password do not match.");
            return;
        }

        if (newPassword.length < 8) {
            alert("Password must be at least 8 characters long.");
            return;
        }

        updatePasswordBtn.disabled = true;
        updatePasswordBtn.textContent = 'Updating...';

        try {
            const credential = EmailAuthProvider.credential(user.email, currentPassword);
            await reauthenticateWithCredential(user, credential);

            await updatePassword(user, newPassword);

            await addDoc(collection(db, "audit"), {
                timestamp: new Date(),
                user: displayNameInput.value.trim() || user.email,
                userId: user.uid,
                role: currentUserRole || 'Administrator',
                action: 'update',
                target: 'Security Settings',
                details: 'User successfully updated account password.',
                status: 'success'
            });

            alert("Password updated successfully!");
            changePasswordForm.reset();

        } catch (error) {
            console.error("Error updating password:", error);

            let errorMessage = "Failed to update password.";
            if (error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
                errorMessage = "Incorrect current/temporary password.";
            } else if (error.code === 'auth/weak-password') {
                errorMessage = "Password is too weak. Choose a stronger password.";
            }

            await addDoc(collection(db, "audit"), {
                timestamp: new Date(),
                user: displayNameInput.value.trim() || user.email,
                userId: user.uid,
                role: currentUserRole || 'Administrator',
                action: 'update',
                target: 'Security Settings',
                details: `Failed password change attempt: ${error.message}`,
                status: 'failed'
            });

            alert(errorMessage);
        } finally {
            updatePasswordBtn.disabled = false;
            updatePasswordBtn.textContent = 'Update Password';
        }
    });
}

