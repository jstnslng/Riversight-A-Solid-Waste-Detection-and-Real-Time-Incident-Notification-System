import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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
export { firebaseConfig };