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

const tableBody = document.querySelector('.report-table tbody');

const profileMenu = document.querySelector('[data-profile-menu]');
const profileToggle = document.querySelector('[data-profile-toggle]');
const logoutLink = document.querySelector('[data-logout-link]');

let allReports = [];
let allCameras = [];

async function fetchReportStats() {
    try {
        const querySnapshot = await getDocs(collection(db, "reports"));
        allReports = [];
        allReports = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
    }));

        updateStats();
        displayReports(allReports);

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

    const totalDetections = 0; // hardcoded for now, change once detections are implemented
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

function displayReports(reports){
    tableBody.innerHTML = '';

    if (reports.length === 0){
        tableBody.innerHTML = `
            <tr>
                <td>
                    No reports found matching your criteria.
                </td>
            </tr>
        `;
        return;
    }

    reports.forEach(report => {
        const tr = document.createElement('tr');
        const formattedDate = formatTimestamp(report.createdAt);

        const typeClass = (report.detectionType || 'incident').toLowerCase().replace(/\s+/g, '-');
        const severityClass = (report.severity || 'low').toLowerCase();
        const statusClass = (report.status || 'open').toLowerCase();

        tr.innerHTML = `
            <td>${report.reportId || report.id}</td>
            <td><span class="type-badge ${typeClass}">${report.detectionType || 'N/A'}</span></td>
            <td>${report.camId || 'N/A'}</td>
            <td>${report.location || 'N/A'}</td>
            <td><span class="severity-badge ${severityClass}">${report.severity || 'N/A'}</span></td>
            <td>${formattedDate}</td>
            <td><span class="status-badge ${statusClass}">${report.status || 'N/A'}</span></td>
            <td><button class="view-btn" type="button" data-id="${report.id}">View</button></td>
        `;
        tableBody.appendChild(tr);
    });
}

function formatTimestamp(timestamp) {
    if (!timestamp) return 'N/A';
    
    let date;
    if (typeof timestamp.toDate === 'function') {
        date = timestamp.toDate();
    } else if (timestamp.seconds) {
        date = new Date(timestamp.seconds * 1000);
    } else {
        date = new Date(timestamp);
    }

    if (isNaN(date.getTime())) return 'N/A';

    return date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

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