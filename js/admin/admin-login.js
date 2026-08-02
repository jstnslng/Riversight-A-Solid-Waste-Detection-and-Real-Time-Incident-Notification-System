import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
    signInWithEmailAndPassword,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// firebase initialization
const firebaseConfig = {
    apiKey: "AIzaSyAwCQ8jvOEn2Q4b5g1b4EuyoG4KgRry5v8",
    authDomain: "riversight-220d9.firebaseapp.com",
    projectId: "riversight-220d9",
    storageBucket: "riversight-220d9.firebasestorage.app",
    messagingSenderId: "121340461725",
    appId: "1:121340461725:web:a3cfe19a633780b98d8a74",
    measurementId: "G-8YPDR5JWXW"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// authentication
const loginForm = document.getElementById('loginForm');
const pwInput = document.getElementById('password');
const toggleBtn = document.getElementById('togglePw');

toggleBtn.addEventListener('click', () => {
    const isPassword = pwInput.type === 'password';
    pwInput.type = isPassword ? 'text' : 'password';
    toggleBtn.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
});

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const submitBtn = loginForm.querySelector('.login-btn');
    const userInput = document.getElementById('username').value.trim();
    const password = pwInput.value;
    const rememberDevice = document.getElementById('remember').checked;

    const email = userInput.includes('@') ? userInput : `${userInput}@riversight.gov.ph`;

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

        if (userData.role !== "Administrator") {
            alert("Access Denied: Account does not have Administrator privileges.");
            await auth.signOut();
            return;
        }

        await updateDoc(userDocRef, {
            last_login: serverTimestamp()
        });

        sessionStorage.setItem('riversightAdminSession', 'active');
        if (rememberDevice) {
            localStorage.setItem('riversightAdminSession', 'active');
        }

        window.location.href = 'Admin-Dashboard.html';

    } catch (error) {
        console.error("Login Error:", error);

        switch (error.code) {
            case 'auth/invalid-credential':
            case 'auth/user-not-found':
            case 'auth/wrong-password':
                alert("Invalid username/email or password.");
                break;
            case 'auth/too-many-requests':
                alert("Account temporarily locked due to too many failed attempts.");
                break;
            default:
                alert(error.message || "An unexpected error occurred.");
        }
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnText;
    }
});