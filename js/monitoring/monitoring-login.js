import {
    signInWithEmailAndPassword,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence,
    signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc, updateDoc, serverTimestamp, addDoc, collection } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { auth, db } from "../shared/firebase-config.js";

const loginForm = document.getElementById('loginForm');
const userField = document.getElementById('username');
const pwField = document.getElementById('password');
const toggleBtn = document.getElementById('togglePw');

toggleBtn.addEventListener('click', () => {
    const isPassword = pwField.type === 'password';
    pwField.type = isPassword ? 'text' : 'password';
    toggleBtn.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
});

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

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
            alert("Access Denied: Account does not have Monitoring privileges.");
            await signOut(auth);
            return;
        }

        if (userData.status && userData.status.toLowerCase() === "inactive") {
            alert("Access Denied: Account is inactive. Please contact support.");
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

        sessionStorage.setItem('riversightMonitoringSession', 'active');
        if (rememberDevice) {
            localStorage.setItem('riversightMonitoringSession', 'active');
        }

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
            alert("Firestore denied access to the account profile. Publish the latest Firestore rules, then try again.");
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
        alert(error.code?.startsWith("auth/")
            ? 'Login failed. Please check your credentials and try again.'
            : (error.message || 'Login failed. Please try again.'));
    } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
    }

});

