import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { auth, db } from "../shared/firebase-config.js";

const loginUrl = new URL("./Monitoring-Login.html", window.location.href);

function clearMonitoringSession() {
  sessionStorage.removeItem("riversightMonitoringSession");
  localStorage.removeItem("riversightMonitoringSession");
}

function redirectToLogin() {
  clearMonitoringSession();
  window.location.replace(loginUrl);
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    redirectToLogin();
    return;
  }

  try {
    const userSnapshot = await getDoc(doc(db, "users", user.uid));
    const userData = userSnapshot.exists() ? userSnapshot.data() : null;
    const accountRole = userData?.role?.trim().toLowerCase();
    const isMonitoringUser = accountRole === "monitoring" || accountRole === "monitoring personnel";
    const accountStatus = userData?.status?.toLowerCase();
    const hasInvalidStatus = accountStatus && accountStatus !== "active";

    if (!isMonitoringUser || hasInvalidStatus) {
      await signOut(auth);
      redirectToLogin();
      return;
    }

    document.body.classList.remove("auth-pending");
  } catch (error) {
    console.error("Monitoring session validation failed:", error);
    try {
      await signOut(auth);
    } finally {
      redirectToLogin();
    }
  }
});

document.addEventListener("click", async (event) => {
  const logoutLink = event.target.closest("[data-logout-link]");
  if (!logoutLink) return;

  event.preventDefault();
  try {
    await signOut(auth);
  } finally {
    clearMonitoringSession();
    window.location.assign(logoutLink.dataset.logoutTarget || loginUrl);
  }
});