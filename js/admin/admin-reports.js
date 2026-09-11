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

const detectionTrendSvg = document.getElementById('detection-trend-svg');
const monthlyBarContainer = document.getElementById('monthly-bar-chart');
const severityDonutSvg = document.getElementById('severity-donut-svg');
const cameraBarsContainer = document.getElementById('camera-activity-bars');

const stationFilter = document.getElementById('filter-station');
const cameraFilter = document.getElementById('filter-camera');
const applyFiltersBtn = document.getElementById('filter-btn');
const resetFiltersBtn = document.getElementById('reset-filters-btn');
const startDateFilter = document.getElementById('filter-start-date');
const endDateFilter = document.getElementById('filter-end-date');
const severityFilter = document.getElementById('filter-severity');
const statusFilter = document.getElementById('filter-status');

const profileMenu = document.querySelector('[data-profile-menu]');
const profileToggle = document.querySelector('[data-profile-toggle]');
const logoutLink = document.querySelector('[data-logout-link]');

let allReports = [];
let allCameras = [];

function populateSelectOptions(selectElement, items, defaultLabel) {
    if (!selectElement) return;

    selectElement.innerHTML = `<option value="ALL">${defaultLabel}</option>`;

    items.sort().forEach(value => {
        if (value) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value;
            selectElement.appendChild(option);
        }
    });
}

function updateFilterDropdowns(reports) {
    const stations = [...new Set(reports.map(r => r.location).filter(Boolean))];
    const cameras = [...new Set(reports.map(r => r.camId).filter(Boolean))];

    populateSelectOptions(stationFilter, stations, 'All Stations');
    populateSelectOptions(cameraFilter, cameras, 'All Cameras');
}

function applyFilters() {
    const selectedStation = stationFilter ? stationFilter.value : 'ALL';
    const selectedCamera = cameraFilter ? cameraFilter.value : 'ALL';
    const selectedSeverity = severityFilter ? severityFilter.value : 'ALL';
    const selectedStatus = statusFilter ? statusFilter.value : 'ALL';
    const startDate = startDateFilter ? new Date(startDateFilter.value) : null;
    const endDate = endDateFilter ? new Date(endDateFilter.value) : null;

    if (endDate) {
        endDate.setHours(23, 59, 59, 999);
    }

    const filteredReports = allReports.filter(report => {
        const matchStation = selectedStation === 'ALL' || report.location === selectedStation;
        const matchCamera = selectedCamera === 'ALL' || report.camId === selectedCamera;
        const matchSeverity = selectedSeverity === 'ALL' || (report.severity || '').toLowerCase() === selectedSeverity.toLowerCase();
        const matchStatus = selectedStatus === 'ALL' || (report.status || '').toLowerCase() === selectedStatus.toLowerCase();

        let matchDate = true;
        if (report.timestamp) {
            const reportDate = report.timestamp.toDate ? report.timestamp.toDate() : new Date(report.timestamp);
            if (startDate && reportDate < startDate) {
                matchDate = false;
            }
            if (endDate && reportDate > endDate) {
                matchDate = false;
            }
        }

        return matchStation && matchCamera && matchSeverity && matchStatus && matchDate;
    })

    displayReports(filteredReports);
}

function resetFilters() {
    if (stationFilter) stationFilter.value = 'ALL';
    if (cameraFilter) cameraFilter.value = 'ALL';
    if (severityFilter) severityFilter.value = 'ALL';
    if (statusFilter) statusFilter.value = 'ALL';
    if (startDateFilter) startDateFilter.value = '';
    if (endDateFilter) endDateFilter.value = '';
}

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

        updateFilterDropdowns(allReports);

        renderDetectionTrend(allReports);
        renderMonthlyReports(allReports);
        renderSeverityDistribution(allReports);
        renderCameraActivity(allReports, allCameras);

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

        renderCameraActivity(allReports, allCameras);

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
        (report.severity || "").toLowerCase() === "critical" || (report.severity || "").toLowerCase() === "severe" && (report.status || "").toLowerCase() === "ongoing").length;
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

function renderDetectionTrend(reports) {
    if (!detectionTrendSvg) return;

    const hoursBins = [0, 0, 0, 0, 0, 0];
    const now = new Date();

    reports.forEach(r => {
        const date = parseReportDate(r.createdAt);
        if (date && (now - date) <= 24 * 60 * 60 * 1000) {
            const binIndex = Math.min(5, Math.floor(date.getHours() / 4));
            hoursBins[binIndex]++;
        }
    });

    const maxVal = Math.max(...hoursBins, 10);
    const points = hoursBins.map((val, idx) => {
        const x = 36 + idx * 56;
        const y = 150 - (val / maxVal) * 120;
        return `${x},${y}`;
    });

    const pathD = `M36,150 L${points.join(' L')}`;
    const fillD = `${pathD} L334,150 Z`;

    detectionTrendSvg.innerHTML = `
        <line x1="36" y1="12" x2="36" y2="150" stroke="#e2e2e2" stroke-width="1"/>
        <line x1="36" y1="150" x2="340" y2="150" stroke="#e2e2e2" stroke-width="1"/>
        <path d="${fillD}" fill="#111111" fill-opacity="0.06"/>
        <path d="${pathD}" fill="none" stroke="#111111" stroke-width="2.4"/>
        <text x="6" y="16" class="axis-label">${maxVal}</text>
        <text x="10" y="84" class="axis-label">${Math.round(maxVal / 2)}</text>
        <text x="14" y="152" class="axis-label">0</text>
    `;
}

function renderMonthlyReports(reports) {
    if (!monthlyBarContainer) return;
    monthlyBarContainer.innerHTML = '';

    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthCounts = new Array(12).fill(0);

    reports.forEach(r => {
        const date = parseReportDate(r.createdAt);
        if (date) {
            monthCounts[date.getMonth()]++;
        }
    });

    const maxCount = Math.max(...monthCounts, 1);

    for (let i = 0; i < 12; i++) {
        if (monthCounts[i] === 0 && i > 7) continue; 

        const pct = Math.round((monthCounts[i] / maxCount) * 100);
        const row = document.createElement('div');
        row.className = 'bar-row';
        row.innerHTML = `
            <span>${months[i]}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
            <strong>${monthCounts[i]}</strong>
        `;
        monthlyBarContainer.appendChild(row);
    }
}

function renderSeverityDistribution(reports) {
    if (!severityDonutSvg) return;

    let critical = 0, high = 0, low = 0;
    reports.forEach(r => {
        const sev = (r.severity || '').toLowerCase();
        if (sev === 'critical' || sev === 'severe') critical++;
        else if (sev === 'high' || sev === 'medium') high++;
        else low++;
    });

    const total = critical + high + low || 1;
    const critPct = (critical / total) * 100;
    const highPct = (high / total) * 100;

    const critDash = `${critPct} ${100 - critPct}`;
    const highDash = `${highPct} ${100 - highPct}`;
    const lowDash = `${(low / total) * 100} ${100 - (low / total) * 100}`;

    severityDonutSvg.innerHTML = `
        <circle cx="21" cy="21" r="15.9" fill="transparent" stroke="#ececec" stroke-width="6.5"></circle>
        <circle cx="21" cy="21" r="15.9" fill="transparent" stroke="#111111" stroke-width="6.5" 
            stroke-dasharray="${critDash}" stroke-dashoffset="25"></circle>
        <circle cx="21" cy="21" r="15.9" fill="transparent" stroke="#7a7a7a" stroke-width="6.5" 
            stroke-dasharray="${highDash}" stroke-dashoffset="${25 - critPct}"></circle>
        <circle cx="21" cy="21" r="15.9" fill="transparent" stroke="#e0a020" stroke-width="6.5" 
            stroke-dasharray="${lowDash}" stroke-dashoffset="${25 - critPct - highPct}"></circle>
    `;
}

function renderCameraActivity(reports, cameras) {
    if (!cameraBarsContainer) return;
    cameraBarsContainer.innerHTML = '';

    const cameraCounts = {};
    reports.forEach(r => {
        if (r.camId) {
            cameraCounts[r.camId] = (cameraCounts[r.camId] || 0) + 1;
        }
    });

    const totalReports = reports.length || 1;
    const activeList = cameras.map(c => c.camId || c.id).filter(Boolean);
    const listToRender = activeList.length ? activeList : Object.keys(cameraCounts);

    if (listToRender.length === 0) {
        cameraBarsContainer.innerHTML = '<div style="padding: 12px; color: #666;">No camera data found</div>';
        return;
    }

    listToRender.forEach(camId => {
        const count = cameraCounts[camId] || 0;
        const pct = Math.round((count / totalReports) * 100);

        const bar = document.createElement('div');
        bar.className = 'camera-bar';
        bar.innerHTML = `
            <span>${camId}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
            <strong>${pct}%</strong>
        `;
        cameraBarsContainer.appendChild(bar);
    });
}

function parseReportDate(ts) {
    if (!ts) return null;
    if (typeof ts.toDate === 'function') return ts.toDate();
    if (ts.seconds) return new Date(ts.seconds * 1000);
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
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

applyFiltersBtn.addEventListener('click', applyFilters);
resetFiltersBtn.addEventListener('click', () => {
    resetFilters();
    displayReports(allReports);
});