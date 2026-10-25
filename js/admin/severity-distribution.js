const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const CIRCUMFERENCE = 100;
const START_OFFSET = 25;

const severityGroups = [
  { key: "critical", label: "Critical/Severe", color: "var(--red)" },
  { key: "high", label: "High/Medium", color: "var(--orange)" },
  { key: "low", label: "Low", color: "#7a7a7a" },
];

export function renderSeverityDistribution(svg, reports) {
  if (!svg) return;

  const counts = { critical: 0, high: 0, low: 0 };
  reports.forEach((report) => {
    const severity = (report.severity || "").toLowerCase();
    if (severity === "critical" || severity === "severe") {
      counts.critical += 1;
    } else if (severity === "high" || severity === "medium") {
      counts.high += 1;
    } else {
      counts.low += 1;
    }
  });

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const summary = severityGroups
    .map(({ key, label }) => `${label} ${counts[key]}`)
    .join(", ");
  svg.setAttribute("aria-label", `Severity distribution: ${summary}. Total ${total} reports.`);
  svg.replaceChildren();

  const background = document.createElementNS(SVG_NAMESPACE, "circle");
  background.setAttribute("cx", "21");
  background.setAttribute("cy", "21");
  background.setAttribute("r", "15.9");
  background.setAttribute("fill", "transparent");
  background.setAttribute("stroke", "#ececec");
  background.setAttribute("stroke-width", "6.5");
  svg.appendChild(background);

  let offset = START_OFFSET;
  severityGroups.forEach(({ key, color }) => {
    if (counts[key] === 0 || total === 0) return;

    const percentage = (counts[key] / total) * CIRCUMFERENCE;
    const segment = document.createElementNS(SVG_NAMESPACE, "circle");
    segment.setAttribute("cx", "21");
    segment.setAttribute("cy", "21");
    segment.setAttribute("r", "15.9");
    segment.setAttribute("fill", "transparent");
    segment.setAttribute("stroke", color);
    segment.setAttribute("stroke-width", "6.5");
    segment.setAttribute("stroke-dasharray", `${percentage} ${CIRCUMFERENCE - percentage}`);
    segment.setAttribute("stroke-dashoffset", String(offset));
    svg.appendChild(segment);
    offset -= percentage;
  });
}
