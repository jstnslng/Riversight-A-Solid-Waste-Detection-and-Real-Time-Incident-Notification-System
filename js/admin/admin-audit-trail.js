import { collection, getDocs, doc, serverTimestamp, setDoc, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
    getAuth,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { auth, db, firebaseConfig } from "../shared/firebase-config.js";

const profileMenu = document.querySelector('[data-profile-menu]');
const profileToggle = document.querySelector('[data-profile-toggle]');
const logoutLink = document.querySelector('[data-logout-link]');

const startDateInput = document.getElementById('auditStartDate');
const endDateInput = document.getElementById('auditEndDate');
const actionFilterSelect = document.getElementById('auditActionFilter');
const resetFiltersButton = document.getElementById('resetAuditFilters');
const applyFiltersButton = document.getElementById('applyAuditFilters');
const tableBody = document.getElementById('auditLogBody');

const totalEventsStat = document.querySelector('[data-stat-total-events]');
const loginEventsStat = document.querySelector('[data-stat-login-events]');
const profileEditsStat = document.querySelector('[data-stat-profile-edits]');
const failedActionsStat = document.querySelector('[data-stat-failed-actions]');

const reloadButton = document.getElementById('reloadAuditLogs');

let auditLogs = [];

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'Admin-Login.html';
    }

    fetchAuditLogs();

});

const fetchAuditLogs = async () => {
    try {
        const auditCollectionRef = collection(db, "audit");
        const q = query(auditCollectionRef, orderBy("timestamp", "desc"));
        const auditSnapshot = await getDocs(q);
        
        auditLogs = auditSnapshot.docs.map((doc) => {
            const data = doc.data();
            return {
                id: doc.id,
                user: data.username || data.userName || data.user || 'Unknown User',
                userId: data.userId || data.userID || data.uid || 'N/A',
                role: data.role || 'Unknown Role',
                action: (data.action || 'unknown').toLowerCase(),
                target: data.target || data.targetType || 'System',
                details: data.details || 'No details provided',
                status: (data.status || 'recorded').toLowerCase(),
                timestamp: data.timestamp
            };
        });

        applyFilters();
    } catch (error) {
        console.error("Error fetching audit logs:", error);
        if (tableBody) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align:center; padding:24px; color: var(--danger, red);">
                        Failed to load audit logs: ${error.message}
                    </td>
                </tr>
            `;
        }
    }
};

function closeProfileMenu() {
    if (!profileMenu || !profileToggle) return;
    profileMenu.classList.remove('open');
    profileToggle.setAttribute('aria-expanded', 'false');
}

function bindProfileMenu() {
    if (!profileMenu || !profileToggle) return;

    profileToggle.addEventListener('click', (event) => {
        event.stopPropagation();
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
}

function bindLogout() {
    if (!logoutLink) return;

    logoutLink.addEventListener('click', (event) => {
        event.preventDefault();
        localStorage.removeItem('riversightAdminSession');
        sessionStorage.removeItem('riversightAdminSession');
        window.location.href = logoutLink.href;
    });
}

function parseTimestamp(timestamp) {
    if (!timestamp) return new Date(0);
    if (typeof timestamp.toDate === 'function') {
        return timestamp.toDate();
    }
    if (timestamp.seconds) {
        return new Date(timestamp.seconds * 1000);
    }
    return new Date(timestamp);
}

function formatTimestamp(timestamp) {
    if (!timestamp) return '';
    const date = parseTimestamp(timestamp);
    if (isNaN(date.getTime())) return '';

    return date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function renderTable(rows) {
    if (!tableBody) return;

    if (rows.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="5" style="text-align:center; padding:24px; color: var(--muted, #666);">
                    No audit entries match the selected filters.
                </td>
            </tr>
        `;
        return;
    }

    tableBody.innerHTML = rows.map((entry) => `
        <tr>
            <td>${formatTimestamp(entry.timestamp)}</td>
            <td>
                <div class="audit-user-cell">
                    <div class="u-name">${entry.user}</div>
                    <div class="u-email" title="${entry.role}">${entry.role}</div>
                </div>
            </td>
            <td><span class="audit-action-badge ${entry.action}">${entry.action.toUpperCase()}</span></td>
            <td>
                <div class="audit-target">
                    <strong>${entry.target}</strong>
                    <span>${entry.details}</span>
                </div>
            </td>
            <td><span class="audit-status-badge ${entry.status}">${entry.status.toUpperCase()}</span></td>
        </tr>
    `).join('');
}

function updateStats(rows) {
    const loginEvents = rows.filter((entry) => 
        entry.action.toLowerCase().includes('login')
    ).length;

    const profileEdits = rows.filter((entry) => 
        (entry.target || '').toLowerCase().includes('profile')
    ).length;

    const failedActions = rows.filter((entry) => 
        entry.status.toLowerCase() === 'failed'
    ).length;

    if (totalEventsStat) totalEventsStat.textContent = String(rows.length);
    if (loginEventsStat) loginEventsStat.textContent = String(loginEvents);
    if (profileEditsStat) profileEditsStat.textContent = String(profileEdits);
    if (failedActionsStat) failedActionsStat.textContent = String(failedActions);
}

function applyFilters() {
    const startDate = startDateInput?.value ? new Date(`${startDateInput.value}T00:00:00`) : null;
    const endDate = endDateInput?.value ? new Date(`${endDateInput.value}T23:59:59`) : null;
    const selectedAction = (actionFilterSelect?.value || 'all').toLowerCase();

    const filteredRows = auditLogs.filter((entry) => {
        const timestamp = parseTimestamp(entry.timestamp);
        const userName = (entry.user || '').toLowerCase();
        const actionMatch = selectedAction === 'all' || entry.action === selectedAction || entry.action.includes(selectedAction);
        const startMatch = !startDate || timestamp >= startDate;
        const endMatch = !endDate || timestamp <= endDate;
        return actionMatch && startMatch && endMatch;
    }).sort((left, right) => parseTimestamp(right.timestamp) - parseTimestamp(left.timestamp));

    renderTable(filteredRows);
    updateStats(filteredRows);
}

function bindFilters() {
    [startDateInput, endDateInput,, actionFilterSelect].forEach((control) => {
        control?.addEventListener('change', applyFilters);
    });

    if (resetFiltersButton) {
        resetFiltersButton.addEventListener('click', () => {
            if (startDateInput) startDateInput.value = '';
            if (endDateInput) endDateInput.value = '';
            if (actionFilterSelect) actionFilterSelect.value = 'all';
            applyFilters();
        });
    }

    if (applyFiltersButton) {
        applyFiltersButton.addEventListener('click', applyFilters);
    }
}

reloadButton?.addEventListener('click', () => {
    location.reload();

});

bindProfileMenu();
bindLogout();
bindFilters();
applyFilters();
