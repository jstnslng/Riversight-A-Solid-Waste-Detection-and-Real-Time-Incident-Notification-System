import { auth, db, firebaseConfig } from "../shared/firebase-config.js";
import { collection, getDoc, doc, serverTimestamp, getDocs } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
    signOut as authSignOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const totalReportsOutput = document.getElementById('total-reports');
const totalIncidentsOutput = document.getElementById('total-incidents');
const totalDetectionsOutput = document.getElementById('total-detections');
const activeCamerasOutput = document.getElementById('active-cameras');
const criticalAlertsOutput = document.getElementById('critical-alerts');
const resolvedIncidentsOutput = document.getElementById('resolved-incidents');

const profileMenu = document.querySelector('[data-profile-menu]');
const profileToggle = document.querySelector('[data-profile-toggle]');
const logoutLink = document.querySelector('[data-logout-link]');

let allReports = [];
let allCameras = [];

async function fetchReportStats() {
    try {
        const querySnapshot = await getDocs(collection(db, "reports"));
        allReports = [];
        querySnapshot.forEach((docSnap ) => {
            allReports.push(docSnap.data());
        });

        updateStats();

    } catch (error) {
        console.error("Error fetching report stats:", error);
    }
}

async function fetchCameraStats(){
    try {
        const querySnapshot = await getDocs(collection(db, "camera_feeds"));
        allCameras = [];
        querySnapshot.forEach((docSnap ) => {
            allCameras.push(docSnap.data());
        });
        updateStats();
    } catch (error) {
        console.error("Error fetching camera stats:", error);
    }
}

function updateStats() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const totalReports = allReports.length;
    
    const totalIncidents = allReports.filter(report => {
        if (!report.createdAt) return false;
        const createdAtDate = report.createdAt.toDate ? report.createdAt.toDate() : new Date(report.createdAt);
        return createdAtDate >= thirtyDaysAgo;
    }).length;

    const totalDetections = 0; // hardcoded for now
    const activeCameras = allCameras.filter(camera => (camera.status || "offline").toLowerCase() === "online").length;
    const criticalAlerts = allReports.filter(report => 
        (report.severity || "").toLowerCase() === "critical" || (report.severity || "").toLowerCase() === "severe").length;
    const resolvedIncidents = allReports.filter(report => (report.status || "").toLowerCase() === "resolved").length;

    if (totalReportsOutput) totalReportsOutput.textContent = totalReports.toLocaleString();
    if (totalIncidentsOutput) totalIncidentsOutput.textContent = totalIncidents.toLocaleString();
    if (totalDetectionsOutput) totalDetectionsOutput.textContent = totalDetections.toLocaleString();
    if (activeCamerasOutput) activeCamerasOutput.textContent = activeCameras.toLocaleString();
    if (criticalAlertsOutput) criticalAlertsOutput.textContent = criticalAlerts.toLocaleString();
    if (resolvedIncidentsOutput) resolvedIncidentsOutput.textContent = resolvedIncidents.toLocaleString();
}

onAuthStateChanged(auth, (user) => {
    if (user) {
        fetchReportStats();
        fetchCameraStats();
    } else {
        window.location.href = './Admin-Login.html';
    }
});

const closeProfileMenu = () => {
    profileMenu.classList.remove('open');
    profileToggle.setAttribute('aria-expanded', 'false');
};

profileToggle.addEventListener('click', () => {
    const isOpen = profileMenu.classList.toggle('open');
    profileToggle.setAttribute('aria-expanded', String(isOpen));
});

document.addEventListener('click', (event) => {
    if (!profileMenu.contains(event.target)) {
    closeProfileMenu();
    }
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
    closeProfileMenu();
    }
});

logoutLink.addEventListener('click', (event) => {
    event.preventDefault();
    localStorage.removeItem('riversightAdminSession');
    sessionStorage.removeItem('riversightAdminSession');
    window.location.href = logoutLink.href;
});