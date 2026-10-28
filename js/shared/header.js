import { db } from "./firebase-config.js";
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

document.addEventListener("DOMContentLoaded", () => {
  initRealtimeNotifications();
});

export function initRealtimeNotifications() {
  const badgeElems = document.querySelectorAll("[data-notification-badge]");
  if (badgeElems.length === 0) return;

  // Real-time query for unread notifications
  const q = query(
    collection(db, "notifications"),
    where("status", "==", "unread")
  );

  onSnapshot(q, (snapshot) => {
    const unreadCount = snapshot.size;

    badgeElems.forEach((badge) => {
      if (unreadCount > 0) {
        badge.textContent = unreadCount > 99 ? "99+" : unreadCount;
        badge.style.display = "inline-flex";
      } else {
        badge.textContent = "";
        badge.style.display = "none";
      }
    });
  }, (error) => {
    console.error("Error streaming notification counts:", error);
  });
}