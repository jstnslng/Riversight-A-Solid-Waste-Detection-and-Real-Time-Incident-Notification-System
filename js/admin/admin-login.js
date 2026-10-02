import {
    signInWithEmailAndPassword,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence,
    signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc, updateDoc, serverTimestamp, addDoc, collection } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { auth, db, saveLoginSession, getRememberedAccount, clearRememberedAccount } from "../shared/firebase-config.js";

// authentication
const loginForm = document.getElementById('loginForm');
const pwInput = document.getElementById('password');
const toggleBtn = document.getElementById('togglePw');
const loginMessage = document.getElementById('loginMessage');
const loginMessageText = document.getElementById('loginMessageText');
const usernameInput = document.getElementById('username');
const rememberInput = document.getElementById('remember');

const rememberedAccount = getRememberedAccount("admin");
if (rememberedAccount) {
    usernameInput.value = rememberedAccount;
    rememberInput.checked = true;
}

rememberInput.addEventListener('change', () => {
    if (!rememberInput.checked) clearRememberedAccount("admin");
});

function showLoginMessage(message) {
    loginMessageText.textContent = message;
    loginMessage.hidden = false;
}

toggleBtn.addEventListener('click', () => {
    const isPassword = pwInput.type === 'password';
    pwInput.type = isPassword ? 'text' : 'password';
    toggleBtn.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
});

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginMessage.hidden = true;
    loginMessageText.textContent = '';

    const submitBtn = loginForm.querySelector('.login-btn');
    const userInput = usernameInput.value.trim();
    const password = pwInput.value;
    const rememberDevice = document.getElementById('remember').checked;

    const email = userInput.includes('@') ? userInput : `${userInput}@gmail.com`;

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

        if (userData.role?.trim().toLowerCase() !== "administrator") {
            showLoginMessage("This account does not have administrator access.");
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
            console.warn("Could not update administrator last-login time:", error);
        }

        saveLoginSession("admin", rememberDevice, userInput);

        const loginAudit = {
            userId: auth.currentUser?.uid || "N/A",
            username: userData.username || userData.email,
            action: "Login",
            timestamp: serverTimestamp(),
            target: "Session",
            details: `Administrator ${userData.username || userData.email} logged in.`,
            role: userData.role || "Administrator",
            status: "Success"
        }

        void addDoc(collection(db, "audit"), loginAudit).catch((error) => {
            console.warn("Could not record administrator login audit:", error);
        });

        window.location.href = 'Admin-Dashboard.html';

    } catch (error) {
        console.error("Login Error:", error);
        if (error.code === "permission-denied") {
            await signOut(auth);
            showLoginMessage("We couldn't verify your account. Please try again or contact support.");
        } else if (error.code === "auth/too-many-requests") {
            showLoginMessage("Too many attempts. Your account is temporarily locked; try again later.");
        } else if (["auth/invalid-credential", "auth/user-not-found", "auth/wrong-password"].includes(error.code)) {
            showLoginMessage("Incorrect username/email or password. Please try again.");
        } else {
            showLoginMessage("We couldn't sign you in right now. Please try again.");
        }

        const failedLoginAudit = {
            userId: "Unknown",
            username: email,
            action: "Login",
            timestamp: serverTimestamp(),
            target: "Session",
            details: `Failed login attempt for ${email}.`,
            role: "Administrator",
            status: "Failed"
        };
        void addDoc(collection(db, "audit"), failedLoginAudit).catch((auditError) => {
            console.warn("Could not record failed administrator login audit:", auditError);
        });
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnText;
    }
});