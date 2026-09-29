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

const REMEMBERED_SESSION_DURATION = 30 * 24 * 60 * 60 * 1000;
const MAX_TIMEOUT = 2_147_000_000;
const rememberedSessions = {
    admin: {
        sessionKey: "riversightAdminSession",
        expirationKey: "riversightAdminSessionExpiresAt",
        accountKey: "riversightRememberedAdminAccount",
        accountExpirationKey: "riversightRememberedAdminAccountExpiresAt",
        loginPage: "Admin-Login.html"
    },
    monitoring: {
        sessionKey: "riversightMonitoringSession",
        expirationKey: "riversightMonitoringSessionExpiresAt",
        accountKey: "riversightRememberedMonitoringAccount",
        accountExpirationKey: "riversightRememberedMonitoringAccountExpiresAt",
        loginPage: "Monitoring-Login.html"
    }
};

let rememberedSessionTimeout;
let isExpiringSession = false;

export function saveLoginSession(role, rememberDevice, accountIdentifier = "") {
    const session = rememberedSessions[role];
    if (!session) throw new Error(`Unknown login session role: ${role}`);

    window.clearTimeout(rememberedSessionTimeout);
    sessionStorage.setItem(session.sessionKey, "active");
    if (rememberDevice) {
        const expiresAt = String(Date.now() + REMEMBERED_SESSION_DURATION);
        localStorage.setItem(session.sessionKey, "active");
        localStorage.setItem(session.expirationKey, expiresAt);
        localStorage.setItem(session.accountKey, accountIdentifier);
        localStorage.setItem(session.accountExpirationKey, expiresAt);
    } else {
        localStorage.removeItem(session.sessionKey);
        localStorage.removeItem(session.expirationKey);
        clearRememberedAccount(role);
    }
}

export function getRememberedAccount(role) {
    const session = rememberedSessions[role];
    if (!session) return "";

    const account = localStorage.getItem(session.accountKey) || "";
    const expiration = Number(localStorage.getItem(session.accountExpirationKey));
    if (!account || !Number.isFinite(expiration) || expiration <= Date.now()) {
        clearRememberedAccount(role);
        return "";
    }

    return account;
}

export function clearRememberedAccount(role) {
    const session = rememberedSessions[role];
    if (!session) return;

    localStorage.removeItem(session.accountKey);
    localStorage.removeItem(session.accountExpirationKey);
}

export function clearAuthSessions() {
    Object.values(rememberedSessions).forEach((session) => {
        sessionStorage.removeItem(session.sessionKey);
        localStorage.removeItem(session.sessionKey);
        localStorage.removeItem(session.expirationKey);
    });
}

function expireRememberedSession(session) {
    if (isExpiringSession) return;
    isExpiringSession = true;

    Object.values(rememberedSessions).forEach((storedSession) => {
        localStorage.removeItem(storedSession.sessionKey);
        localStorage.removeItem(storedSession.expirationKey);
        sessionStorage.removeItem(storedSession.sessionKey);
    });
    clearRememberedAccount(Object.keys(rememberedSessions).find((role) => rememberedSessions[role] === session));

    signOut(auth)
        .catch((error) => console.error("Could not end expired session:", error))
        .finally(() => {
            if (!window.location.pathname.endsWith(session.loginPage)) {
                window.location.replace(new URL(`./${session.loginPage}`, window.location.href));
            }
        });
}

function enforceRememberedSession(user, session) {
    const storedExpiration = localStorage.getItem(session.expirationKey);
    let expiration = Number(storedExpiration);
    if (storedExpiration === null) {
        expiration = Date.now() + REMEMBERED_SESSION_DURATION;
        localStorage.setItem(session.expirationKey, String(expiration));
    }

    const remainingTime = expiration - Date.now();
    if (!Number.isFinite(expiration) || remainingTime <= 0) {
        expireRememberedSession(session);
        return;
    }

    rememberedSessionTimeout = window.setTimeout(
        () => enforceRememberedSession(user, session),
        Math.min(remainingTime, MAX_TIMEOUT)
    );
}

onAuthStateChanged(auth, (user) => {
    window.clearTimeout(rememberedSessionTimeout);
    if (!user) {
        isExpiringSession = false;
        return;
    }

    const session = Object.values(rememberedSessions).find(
        (candidate) => localStorage.getItem(candidate.sessionKey) === "active"
    );
    if (session) enforceRememberedSession(user, session);
});