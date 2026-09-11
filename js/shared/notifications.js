import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let unsubscribeReports = null;
let notificationsInitialized = false;

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function parseReportDate(report) {
  const candidates = [report.timestamp, report.dateText, report.evaluatedAt, report.createdAt];
  for (const value of candidates) {
    if (!value) continue;
    if (typeof value.toDate === "function") {
      const date = value.toDate();
      if (!Number.isNaN(date.getTime())) return date;
    }
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function formatNotificationTime(report) {
  const date = parseReportDate(report);
  if (!date) return "Time unavailable";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeSeverity(value) {
  const severity = String(value || "").trim().toUpperCase();
  if (severity === "CRITICAL" || severity === "SEVERE") return { label: severity, className: "critical" };
  if (severity === "HIGH" || severity === "MEDIUM") return { label: severity, className: "warning" };
  if (severity === "NORMAL" || severity === "LOW") return { label: severity, className: "info" };
  return { label: "ALERT", className: "info" };
}

function getDestination() {
  return window.location.pathname.includes("/lib/admin/")
    ? "./Admin-Reports.html"
    : "./Incident-Reports.html";
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function ensureNotificationShell() {
  let toggle = document.querySelector("[data-notification-toggle], #notificationToggle");
  if (!toggle) toggle = document.querySelector(".header-right > .icon-btn");
  if (!toggle) return null;

  toggle.dataset.notificationToggle = "true";
  toggle.id = "notificationToggle";
  toggle.setAttribute("aria-haspopup", "true");
  toggle.setAttribute("aria-expanded", "false");

  let wrapper = toggle.closest(".notification-wrapper");
  if (!wrapper) {
    wrapper = document.createElement("div");
    wrapper.className = "notification-wrapper";
    toggle.parentNode.insertBefore(wrapper, toggle);
    wrapper.appendChild(toggle);
  }

  let dropdown = wrapper.querySelector("#notificationDropdown");
  if (!dropdown) {
    dropdown = document.createElement("div");
    dropdown.id = "notificationDropdown";
    dropdown.className = "notification-dropdown";
    wrapper.appendChild(dropdown);
  }

  dropdown.replaceChildren(
    createElement("div", "notification-dropdown-header", "Recent Reports"),
    createElement("div", "notification-dropdown-body"),
    createElement("a", "notification-dropdown-footer", "View All Incident Reports"),
  );
  dropdown.setAttribute("role", "menu");
  dropdown.setAttribute("aria-label", "Recent reports");
  dropdown.querySelector(".notification-dropdown-footer").href = getDestination();

  const badge = toggle.querySelector("[data-notification-badge], .badge") || (() => {
    const created = createElement("span", "badge");
    created.dataset.notificationBadge = "true";
    toggle.appendChild(created);
    return created;
  })();
  badge.dataset.notificationBadge = "true";
  badge.textContent = "";
  badge.style.display = "none";

  return { toggle, wrapper, dropdown, body: dropdown.querySelector(".notification-dropdown-body"), badge };
}

function closeProfileDropdown() {
  document.querySelectorAll(".profile-dropdown.show, .profile-dropdown.is-visible, .profile-dropdown.active").forEach((dropdown) => {
    dropdown.classList.remove("show", "is-visible", "active");
  });
  document.querySelectorAll(".profile-menu.open, .profile-menu.is-active, .profile-menu.active").forEach((menu) => {
    menu.classList.remove("open", "is-active", "active");
  });
}

function renderEmpty(body, message) {
  body.replaceChildren(createElement("div", "notification-empty", message));
}

function renderReports(shell, reports) {
  const activeReports = reports
    .filter((report) => normalizeStatus(report.status) !== "resolved")
    .sort((left, right) => {
      const leftDate = parseReportDate(left)?.getTime() ?? -Infinity;
      const rightDate = parseReportDate(right)?.getTime() ?? -Infinity;
      return rightDate - leftDate;
    });

  shell.badge.textContent = String(activeReports.length);
  shell.badge.style.display = activeReports.length ? "flex" : "none";

  if (!activeReports.length) {
    renderEmpty(shell.body, "No active reports");
    return;
  }

  shell.body.replaceChildren();
  activeReports.slice(0, 5).forEach((report) => {
    const severity = normalizeSeverity(report.severity);
    const link = createElement("a", "notification-item");
    link.href = getDestination();
    link.setAttribute("role", "menuitem");

    const title = createElement("div", "notification-item-title");
    title.append(
      createElement("span", `notification-severity ${severity.className}`, `${severity.label}: ${report.reportId || report.id || "Report"}`),
      createElement("span", "notification-time", formatNotificationTime(report)),
    );
    const description = createElement("div", "notification-description", `${report.detectionType || "Waste activity"} - ${report.location || "Location N/A"}`);
    link.append(title, description);
    shell.body.appendChild(link);
  });
}

function subscribe(shell) {
  if (unsubscribeReports) unsubscribeReports();
  unsubscribeReports = onSnapshot(collection(db, "reports"), (snapshot) => {
    renderReports(shell, snapshot.docs.map((reportDoc) => ({ id: reportDoc.id, ...reportDoc.data() })));
  }, (error) => {
    console.error("Unable to load notifications.", error);
    shell.badge.style.display = "none";
    renderEmpty(shell.body, "Unable to load notifications.");
  });
}

export function initNotifications() {
  if (notificationsInitialized) return;
  notificationsInitialized = true;

  const shell = ensureNotificationShell();
  if (!shell) {
    notificationsInitialized = false;
    return;
  }

  const close = () => {
    shell.dropdown.classList.remove("show");
    shell.toggle.setAttribute("aria-expanded", "false");
  };

  shell.toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    closeProfileDropdown();
    const open = shell.dropdown.classList.toggle("show");
    shell.toggle.setAttribute("aria-expanded", String(open));
  });

  document.addEventListener("click", (event) => {
    if (!shell.wrapper.contains(event.target)) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  document.querySelectorAll("[data-profile-toggle]").forEach((profileToggle) => {
    profileToggle.addEventListener("click", close);
  });

  onAuthStateChanged(auth, (user) => {
    if (unsubscribeReports) {
      unsubscribeReports();
      unsubscribeReports = null;
    }
    if (user) subscribe(shell);
    else {
      shell.badge.style.display = "none";
      renderEmpty(shell.body, "Sign in to view reports");
    }
  });
}

