import {
    signInWithEmailAndPassword,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence,
    signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc, updateDoc, serverTimestamp, addDoc, collection } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { auth, db, saveLoginSession, getRememberedAccount, clearRememberedAccount } from "../shared/firebase-config.js";

const loginForm = document.getElementById('loginForm');
const userField = document.getElementById('username');
const pwField = document.getElementById('password');
const toggleBtn = document.getElementById('togglePw');
const loginMessage = document.getElementById('loginMessage');
const loginMessageText = document.getElementById('loginMessageText');
const rememberInput = document.getElementById('remember');

const rememberedAccount = getRememberedAccount("monitoring");
if (rememberedAccount) {
    userField.value = rememberedAccount;
    rememberInput.checked = true;
}

rememberInput.addEventListener('change', () => {
    if (!rememberInput.checked) clearRememberedAccount("monitoring");
});

function showLoginMessage(message) {
    loginMessageText.textContent = message;
    loginMessage.hidden = false;
}

toggleBtn.addEventListener('click', () => {
    const isPassword = pwField.type === 'password';
    pwField.type = isPassword ? 'text' : 'password';
    toggleBtn.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
});

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginMessage.hidden = true;
    loginMessageText.textContent = '';

    const submitBtn = loginForm.querySelector('.login-btn');
    const userInputValue = userField.value.trim();
    const password = pwField.value;
    const rememberDevice = document.getElementById('remember').checked;

    const email = userInputValue.includes('@') ? userInputValue : `${userInputValue}@riversight.gov.ph`;

    if (submitBtn) {
        submitBtn.disabled = true;
    }
    const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
    if (submitBtn) {
        submitBtn.innerHTML = `Authenticating...`;
    }

    try {
        const persistenceType = rememberDevice ? browserLocalPersistence : browserSessionPersistence;
        await setPersistence(auth, persistenceType);

        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        const userDocRef = doc(db, "users", user.uid);
        const userDocSnap = await getDoc(userDocRef);

        if (!userDocSnap.exists()) {
            throw new Error("No user profile record found for this account.");
        }

        const userData = userDocSnap.data();

        const accountRole = userData.role?.trim().toLowerCase();
        if (accountRole !== "monitoring" && accountRole !== "monitoring personnel") {
            showLoginMessage("This account does not have monitoring access.");
            await signOut(auth);
            return;
        }

        if (userData.status && userData.status.toLowerCase() === "inactive") {
            showLoginMessage("This account is inactive. Please contact support.");
            await signOut(auth);
            return;
        }
        else if (userData.status && userData.status.toLowerCase() === "pending") {
            await updateDoc(userDocRef, { status: "active" });
        }

        try {
            await updateDoc(userDocRef, { lastLogin: serverTimestamp() });
        } catch (error) {
            console.warn("Could not update monitoring last-login time:", error);
        }

        saveLoginSession("monitoring", rememberDevice, userInputValue);

        const loginAudit = {
            userId: auth.currentUser?.uid || "N/A",
            username: userData.username || userData.email,
            action: "Login",
            timestamp: serverTimestamp(),
            target: "Session",
            details: `Monitoring user ${userData.username || userData.email} logged in.`,
            role: userData.role || "Monitoring",
            status: "Success"
        };

        

        void addDoc(collection(db, "audit"), loginAudit).catch((error) => {
            console.warn("Could not record monitoring login audit:", error);
        });

        window.location.href = '../monitoring/Live-Monitoring.html';

    } catch (error) {
        console.error('Error during login:', error);
        if (error.code === "permission-denied") {
            await signOut(auth);
            showLoginMessage("We couldn't verify your account. Please try again or contact support.");
            return;
        }
        const loginAudit = {
            userId: "Unknown",
            username: email,
            action: "Login",
            timestamp: serverTimestamp(),
            target: "Session",
            details: `Failed login attempt for ${email}.`,
            role: "Monitoring",
            status: "Failed"
        };
        void addDoc(collection(db, "audit"), loginAudit).catch((auditError) => {
            console.warn("Could not record failed monitoring login audit:", auditError);
        });
        showLoginMessage(error.code?.startsWith("auth/")
            ? 'Incorrect username/email or password. Please try again.'
            : 'We couldn\'t sign you in right now. Please try again.');
    } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
    }

});

