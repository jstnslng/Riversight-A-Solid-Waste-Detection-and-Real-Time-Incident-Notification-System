import { db } from "../shared/firebase-config.js";
import { collection, query, where, onSnapshot, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const baselineY = 170;
const maxVal = 60;
const chartTop = 10;
const chartHeight = baselineY - chartTop;

function valueToHeight(v) {
  return (Math.min(v, maxVal) / maxVal) * chartHeight;
}

function setRect(id, y, height) {
  const el = document.getElementById(id);
  if (!el) return;
  el.setAttribute("y", y);
  el.setAttribute("height", Math.max(height, 0));
}

function renderDay(dayKey, counts) {
  const critH = valueToHeight(counts.critical || 0);
  const highH = valueToHeight(counts.high || 0);
  const medH = valueToHeight(counts.medium || 0);

  const critY = baselineY - critH;
  const highY = critY - highH;
  const medY = highY - medH;

  setRect(`bar-${dayKey}-critical`, critY, critH);
  setRect(`bar-${dayKey}-high`, highY, highH);
  setRect(`bar-${dayKey}-medium`, medY, medH);
}

const sevenDaysAgo = new Date();
sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

const q = query(
  collection(db, "incidents"),
  where("createdAt", ">=", Timestamp.fromDate(sevenDaysAgo))
);

onSnapshot(q, (snapshot) => {
  const counts = {};
  dayKeys.forEach((d) => (counts[d] = { critical: 0, high: 0, medium: 0 }));

  snapshot.forEach((docSnap) => {
    const data = docSnap.data();
    if (!data.createdAt) return;
    const jsDate = data.createdAt.toDate();
    const dayKey = dayKeys[jsDate.getDay()];
    const severity = data.severity || "high";
    counts[dayKey][severity] = (counts[dayKey][severity] || 0) + 1;
  });

  dayKeys.forEach((d) => renderDay(d, counts[d]));
});