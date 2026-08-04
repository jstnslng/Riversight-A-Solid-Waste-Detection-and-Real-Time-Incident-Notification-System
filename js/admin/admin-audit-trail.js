const profileMenu = document.querySelector('[data-profile-menu]');
const profileToggle = document.querySelector('[data-profile-toggle]');
const logoutLink = document.querySelector('[data-logout-link]');

const startDateInput = document.getElementById('auditStartDate');
const endDateInput = document.getElementById('auditEndDate');
const userFilterSelect = document.getElementById('auditUserFilter');
const actionFilterSelect = document.getElementById('auditActionFilter');
const resetFiltersButton = document.getElementById('resetAuditFilters');
const applyFiltersButton = document.getElementById('applyAuditFilters');
const tableBody = document.getElementById('auditLogBody');

const totalEventsStat = document.querySelector('[data-stat-total-events]');
const loginEventsStat = document.querySelector('[data-stat-login-events]');
const profileEditsStat = document.querySelector('[data-stat-profile-edits]');
const failedActionsStat = document.querySelector('[data-stat-failed-actions]');

const auditLogs = [
    {
        timestamp: '2026-08-05T08:14:00',
        user: 'Admin Principal',
        userId: 'ADM-0001',
        action: 'login',
        details: 'Signed in to the admin dashboard from PH-MNL-QC',
        targetType: 'Session',
        targetId: 'AUTH-SESSION-8812',
        status: 'success'
    },
    {
        timestamp: '2026-08-05T08:27:00',
        user: 'Admin Principal',
        userId: 'ADM-0001',
        action: 'profile',
        details: 'Updated email address and phone number',
        targetType: 'Profile',
        targetId: 'users/ADM-0001',
        status: 'recorded'
    },
    {
        timestamp: '2026-08-05T08:41:00',
        user: 'Leah Santos',
        userId: 'MON-0042',
        action: 'export',
        details: 'Exported July reports as CSV',
        targetType: 'Report Export',
        targetId: 'RPT-2026-07',
        status: 'success'
    },
    {
        timestamp: '2026-08-04T16:10:00',
        user: 'Leah Santos',
        userId: 'MON-0042',
        action: 'incident',
        details: 'Changed incident EV-8892-X status to Escalated',
        targetType: 'Incident',
        targetId: 'EV-8892-X',
        status: 'review'
    },
    {
        timestamp: '2026-08-04T15:03:00',
        user: 'Mina Cruz',
        userId: 'ADM-0002',
        action: 'camera',
        details: 'Updated CAM-003 reconnect interval to 30 seconds',
        targetType: 'Camera Config',
        targetId: 'CAM-003',
        status: 'recorded'
    },
    {
        timestamp: '2026-08-03T11:49:00',
        user: 'Mina Cruz',
        userId: 'ADM-0002',
        action: 'logout',
        details: 'Signed out after completing system maintenance review',
        targetType: 'Session',
        targetId: 'AUTH-SESSION-8807',
        status: 'success'
    },
    {
        timestamp: '2026-08-02T09:30:00',
        user: 'Carlos Reyes',
        userId: 'ADM-0003',
        action: 'export',
        details: 'Exported weekly incident summary as PDF',
        targetType: 'Report Export',
        targetId: 'RPT-2026-W31',
        status: 'success'
    },
    {
        timestamp: '2026-08-01T14:22:00',
        user: 'System',
        userId: 'SYS',
        action: 'config',
        details: 'Applied camera monitoring threshold update for Sector 4',
        targetType: 'System Config',
        targetId: 'sector-4-threshold',
        status: 'recorded'
    },
    {
        timestamp: '2026-07-31T07:58:00',
        user: 'Carlos Reyes',
        userId: 'ADM-0003',
        action: 'login',
        details: 'Signed in from approved workstation',
        targetType: 'Session',
        targetId: 'AUTH-SESSION-8798',
        status: 'success'
    },
    {
        timestamp: '2026-07-31T08:04:00',
        user: 'Carlos Reyes',
        userId: 'ADM-0003',
        action: 'profile',
        details: 'Corrected display name in admin profile record',
        targetType: 'Profile',
        targetId: 'users/ADM-0003',
        status: 'recorded'
    }
];

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

function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function renderTable(rows) {
    if (!tableBody) return;

    if (rows.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="5" style="text-align:center; padding:24px; color: var(--muted);">
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
                    <div class="u-email">${entry.userId}</div>
                </div>
            </td>
            <td><span class="audit-action-badge ${entry.action}">${entry.action.toUpperCase()}</span></td>
            <td>
                <div class="audit-target">
                    <strong>${entry.targetType}</strong>
                    <span>${entry.details}</span>
                </div>
            </td>
            <td><span class="audit-status-badge ${entry.status}">${entry.status.toUpperCase()}</span></td>
        </tr>
    `).join('');
}

function updateStats(rows) {
    const loginEvents = rows.filter((entry) => entry.action === 'login').length;
    const profileEdits = rows.filter((entry) => entry.action === 'profile').length;
    const failedActions = rows.filter((entry) => entry.status === 'failed').length;

    if (totalEventsStat) totalEventsStat.textContent = String(rows.length);
    if (loginEventsStat) loginEventsStat.textContent = String(loginEvents);
    if (profileEditsStat) profileEditsStat.textContent = String(profileEdits);
    if (failedActionsStat) failedActionsStat.textContent = String(failedActions);
}

function applyFilters() {
    const startDate = startDateInput?.value ? new Date(`${startDateInput.value}T00:00:00`) : null;
    const endDate = endDateInput?.value ? new Date(`${endDateInput.value}T23:59:59`) : null;
    const selectedUser = (userFilterSelect?.value || 'all').toLowerCase();
    const selectedAction = (actionFilterSelect?.value || 'all').toLowerCase();

    const filteredRows = auditLogs.filter((entry) => {
        const timestamp = new Date(entry.timestamp);
        const userMatch = selectedUser === 'all' || entry.user.toLowerCase().includes(selectedUser);
        const actionMatch = selectedAction === 'all' || entry.action === selectedAction;
        const startMatch = !startDate || timestamp >= startDate;
        const endMatch = !endDate || timestamp <= endDate;
        return userMatch && actionMatch && startMatch && endMatch;
    }).sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp));

    renderTable(filteredRows);
    updateStats(filteredRows);
}

function bindFilters() {
    [startDateInput, endDateInput, userFilterSelect, actionFilterSelect].forEach((control) => {
        control?.addEventListener('change', applyFilters);
    });

    if (resetFiltersButton) {
        resetFiltersButton.addEventListener('click', () => {
            if (startDateInput) startDateInput.value = '';
            if (endDateInput) endDateInput.value = '';
            if (userFilterSelect) userFilterSelect.value = 'all';
            if (actionFilterSelect) actionFilterSelect.value = 'all';
            applyFilters();
        });
    }

    if (applyFiltersButton) {
        applyFiltersButton.addEventListener('click', applyFilters);
    }
}

bindProfileMenu();
bindLogout();
bindFilters();
applyFilters();
