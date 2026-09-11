import { db } from "./firebase-config.js";
import {
  collection,
  query,
  where,
  getDocs,
  limit
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const input = document.getElementById("globalSearchInput");
const resultsBox = document.getElementById("globalSearchResults");
let debounceTimer;

export async function globalSearch(searchTerm) {
  if (!searchTerm || typeof searchTerm !== "string") return [];

  const term = searchTerm.toLowerCase().trim();
  const results = [];

  try {
    const detectionsRef = collection(db, "detections");
    const qDetections = query(
      detectionsRef,
      where("searchKeywords", "array-contains", term),
      limit(5)
    );
    const detectionSnaps = await getDocs(qDetections);
    detectionSnaps.forEach((doc) => {
      results.push({
        id: doc.id,
        type: "Detection",
        ...doc.data()
      });
    });

    const incidentsRef = collection(db, "incidents");
    const qIncidents = query(
      incidentsRef,
      where("searchKeywords", "array-contains", term),
      limit(5)
    );
    const incidentSnaps = await getDocs(qIncidents);
    incidentSnaps.forEach((doc) => {
      results.push({
        id: doc.id,
        type: "Incident",
        ...doc.data()
      });
    });

    return results;
  } catch (error) {
    console.error("Error executing global search in Firestore:", error);
    return [];
  }
}

export function buildKeywords(data) {
  if (!data) return [];
  
  const terms = new Set();

  const addTerm = (val) => {
    if (val && typeof val === "string") {
      const cleaned = val.trim().toLowerCase();
      if (!cleaned) return;

      const words = cleaned.split(/[\s\-()]+/); 
      
      words.forEach((word) => {
        if (word.length >= 2) {
          for (let i = 2; i <= word.length; i++) {
            terms.add(word.substring(0, i));
          }
        }
      });
    }
  };

  addTerm(data.locationNode);
  addTerm(data.materialType);
  addTerm(data.cameraId);
  addTerm(data.severity);
  addTerm(data.status);
  addTerm(data.protocolAction);

  return Array.from(terms);
}

if (input) {
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);

    const term = input.value.trim().toLowerCase();

    if (term.length < 2) {
      if (resultsBox) {
        resultsBox.innerHTML = "";
        resultsBox.style.display = "none";
      }
      return;
    }

    debounceTimer = setTimeout(async () => {
      try {
        const results = await globalSearch(term);
        renderResults(results);
      } catch (err) {
        console.error("Global search execution failed:", err);
      }
    }, 300);
  });

  input.addEventListener("focus", () => {
    if (input.value.trim().length >= 2 && resultsBox && resultsBox.children.length > 0) {
      resultsBox.style.display = "block";
    }
  });
}

document.addEventListener("click", (e) => {
  if (
    resultsBox &&
    input &&
    !input.contains(e.target) &&
    !resultsBox.contains(e.target)
  ) {
    resultsBox.style.display = "none";
  }
});

function renderResults(results) {
  if (!resultsBox) return;

  if (results.length === 0) {
    resultsBox.innerHTML = `<div class="search-empty" style="padding: 12px; color: #888;">No matches found.</div>`;
    resultsBox.style.display = "block";
    return;
  }

  resultsBox.innerHTML = results
    .map((r) => {
      const label = r.locationNode || r.detectionId || r.id;
      const subText = r.materialType || r.status || r.severity || "";

      return `
        <div class="search-result-item" data-id="${r.id}" data-type="${r.type}" style="padding: 10px; cursor: pointer; border-bottom: 1px solid #eee;">
          <span class="search-result-type" style="font-weight: bold; font-size: 0.75rem; text-transform: uppercase; color: #2563eb;">${r.type}</span>
          <div class="search-result-details">
            <span class="search-result-label" style="display: block; font-size: 0.9rem; font-weight: 600;">${label}</span>
            ${subText ? `<span class="search-result-sub" style="font-size: 0.8rem; color: #666;">${subText}</span>` : ""}
          </div>
        </div>
      `;
    })
    .join("");

  resultsBox.style.display = "block";

  const items = resultsBox.querySelectorAll(".search-result-item");
  items.forEach((item) => {
    item.addEventListener("click", () => {
      const id = item.dataset.id;
      const type = item.dataset.type;

      if (type === "Detection") {
        window.location.href = `Waste-Management.html?id=${id}`; // Replace with your exact .html file name
      }       else if (type === "Incident") {
        window.location.href = `Incident-Evaluation.html?id=${id}`;
      }

      resultsBox.style.display = "none";
    });
  });
}