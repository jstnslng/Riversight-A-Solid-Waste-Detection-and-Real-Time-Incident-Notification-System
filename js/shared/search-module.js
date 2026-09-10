import { db as sharedDb } from "./firebase-config.js";
import {
  collection,
  query,
  where,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export function buildKeywords(data) {
  return [data.detectionId, data.locationNode, data.materialType, data.severity, data.status]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .split(/\s+/);
}

export async function globalSearch(term) {
  const t = term.toLowerCase();
  const collections = ["incidents", "detections", "reports"];
  const results = [];

  for (const col of collections) {
    const q = query(collection(sharedDb, col), where("searchKeywords", "array-contains", t));
    const snap = await getDocs(q);
    snap.forEach((d) => results.push({ type: col, id: d.id, ...d.data() }));
  }
  return results;
}