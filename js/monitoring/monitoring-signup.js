import {
    signInWithEmailAndPassword,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence,
    createUserWithEmailAndPassword,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc, updateDoc, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { auth, db } from "../shared/firebase-config.js";

const fullnameField = document.getElementById('fullname');
const barangayField = document.getElementById('barangay');
const passwordField = document.getElementById('password');
const confirmPasswordField = document.getElementById('confirmPassword');

const termsCheckbox = document.getElementById('terms');

const submitButton = document.getElementById('signupBtn');

const signUpForm = document.getElementById('signupForm');

onAuthStateChanged(auth, (user) => {
    if (user && !signUpForm.dataset.submitting) {
        window.location.href = 'Live-Monitoring.html';
    }
});

signUpForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (passwordError) passwordError.textContent = '';

    const fullnameInput = fullnameField.value.trim();
    const barangayInput = barangayField.value.trim();
    const passwordInput = passwordField.value;
    const confirmPasswordInput = confirmPasswordField.value;

    const email = `${fullnameInput.replace(/\s+/g, '').toLowerCase()}@riversight.gov.ph`;

    if (passwordInput !== confirmPasswordInput) {
        if (passwordError) {
            passwordError.textContent = 'Passwords do not match.';
        } else {
            alert('Passwords do not match.');
        }
        delete signUpForm.dataset.submitting;
        return;
    }

    if (submitButton) {
        submitButton.disabled = true;
    }
    const originalBtnText = submitButton ? submitButton.innerHTML : '';
    if (submitButton) {
        submitButton.innerHTML = `Creating Account...`;
    }

    try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, passwordInput);
        const user = userCredential.user;

        await setDoc(doc(db, "users", user.uid), {
            uid: user.uid,
            fullname: fullnameInput,
            barangay: barangayInput,
            email_address: email,
            role: "Monitoring Personnel",
            status: "Active",
            created_at: serverTimestamp(),
            updated_at: serverTimestamp()
        });

        alert('Account created successfully! Redirecting to home page...');
        window.location.href = 'Monitoring-Login.html';
        
    } catch (error) {
        console.error('Error creating user:', error);
        alert(`Error creating account: ${error.message}`);
    } finally {
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.innerHTML = originalBtnText;
        }
    }

});

document.querySelectorAll('.toggle-visibility').forEach(btn => {
    btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        input.type = input.type === 'password' ? 'text' : 'password';
    });
});