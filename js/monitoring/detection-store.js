import { db } from "../shared/firebase-config.js";
import {
  collection,
  onSnapshot,
  query,
  Timestamp,
  where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const subscribers = new Set();
let unsubscribe = null;
let currentDate = "";

function localDateValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function selectedDate() {
  return document.getElementById("detectionDate")?.value || localDateValue(new Date());
}

function dateBounds(value) {
  const start = new Date(`${value}T00:00:00`);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start, end];
}

function notify(callback, snapshot, error) {
  subscribers.forEach((subscriber) => subscriber[callback]?.(snapshot, error));
}

function listen() {
  const value = selectedDate();
  if (unsubscribe && currentDate === value) return;
  unsubscribe?.();
  currentDate = value;
  const [start, end] = dateBounds(value);
  const detections = query(
    collection(db, "detections"),
    where("timestamp", ">=", Timestamp.fromDate(start)),
    where("timestamp", "<", Timestamp.fromDate(end))
  );
  unsubscribe = onSnapshot(
    detections,
    (snapshot) => notify("onSnapshot", snapshot),
    (error) => notify("onError", null, error)
  );
}

export function subscribeDetections(onSnapshot, onError) {
  const subscriber = { onSnapshot, onError };
  subscribers.add(subscriber);
  listen();
  return () => {
    subscribers.delete(subscriber);
    if (!subscribers.size) {
      unsubscribe?.();
      unsubscribe = null;
      currentDate = "";
    }
  };
}

document.getElementById("detectionDate")?.addEventListener("change", listen);
