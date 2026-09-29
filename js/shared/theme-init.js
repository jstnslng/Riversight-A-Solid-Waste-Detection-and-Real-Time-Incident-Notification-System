try {
    const preferences = JSON.parse(localStorage.getItem("riversightSettings") || "{}");
    const theme = preferences.theme === "dark" ? "dark" : "light";
    const fontSize = ["small", "default", "large"].includes(preferences.fontSize)
        ? preferences.fontSize
        : "default";

    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.fontSize = fontSize;
    document.documentElement.style.backgroundColor = theme === "dark" ? "#090b0d" : "#eeeeee";
} catch {
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.fontSize = "default";
    document.documentElement.style.backgroundColor = "#eeeeee";
}