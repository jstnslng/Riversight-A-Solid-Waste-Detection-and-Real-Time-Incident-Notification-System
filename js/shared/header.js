import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { auth, db } from "../shared/firebase-config.js";

const logoutLink = document.querySelector('[data-logout-link]');

const username = document.querySelector('.user-name');
const role = document.querySelector('.user-role');

onAuthStateChanged(auth, (user) => {
    if (user) {
        const userDocRef = doc(db, "users", user.uid);
        getDoc(userDocRef).then((docSnap) => {
            if (docSnap.exists()) {
                const userData = docSnap.data();
                if (username) username.textContent = userData.username || user.email;
                if (role) role.textContent = userData.role || 'User';
            }
        });
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
            if (role == 'Admin') {
                window.location.href = './Admin-Login.html';
            }
            else {
                window.location.href = './Monitoring-Login.html';
            }
        }
    });
}