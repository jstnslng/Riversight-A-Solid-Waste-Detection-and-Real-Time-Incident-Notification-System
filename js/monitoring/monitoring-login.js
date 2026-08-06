import {
    signInWithEmailAndPassword,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
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

        if (userData.role !== "Monitoring") {
            alert("Access Denied: Account does not have Monitoring privileges.");
            await auth.signOut();
            return;
        }

        await updateDoc(userDocRef, {
            lastLogin: serverTimestamp()
        });

        sessionStorage.setItem('riversightMonitoringSession', 'active');
        if (rememberDevice) {
            localStorage.setItem('riversightMonitoringSession', 'active');
        }

        window.location.href = '../monitoring/Live-Monitoring.html';

    } catch (error) {
        console.error('Error during login:', error);
        alert('Login failed. Please check your credentials and try again.');
    } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
    }

});

