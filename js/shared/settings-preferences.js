const STORAGE_KEY = "riversightSettings";
const DEFAULT_PREFERENCES = {
    theme: "light",
    fontSize: "default",
    emailNotifications: true,
    systemAlerts: true,
    detectionAlerts: true,
    twoFactorAuthentication: false,
    sessionTimeout: true
};

function readPreferences() {
    try {
        return { ...DEFAULT_PREFERENCES, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
    } catch {
        return { ...DEFAULT_PREFERENCES };
    }
}

export function applySavedAppearance() {
    const preferences = readPreferences();
    document.documentElement.dataset.theme = preferences.theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.fontSize = ["small", "default", "large"].includes(preferences.fontSize)
        ? preferences.fontSize
        : "default";
}

function setToggleState(button, isOn) {
    button.classList.toggle("off", !isOn);
    button.setAttribute("aria-checked", String(isOn));
}

function showFeedback(message) {
    const feedback = document.getElementById("settingsFeedback");
    if (!feedback) return;
    feedback.textContent = message;
    feedback.hidden = false;
}

export function initializeSettingsPage() {
    const preferences = readPreferences();
    const themeSelect = document.querySelector('[data-setting="theme"]');
    const fontSizeSelect = document.querySelector('[data-setting="fontSize"]');
    const toggles = [...document.querySelectorAll("[data-setting-toggle]")];

    applySavedAppearance();

    if (themeSelect) themeSelect.value = preferences.theme;
    if (fontSizeSelect) fontSizeSelect.value = preferences.fontSize;
    toggles.forEach((button) => setToggleState(button, Boolean(preferences[button.dataset.settingToggle])));

    themeSelect?.addEventListener("change", () => {
        document.documentElement.dataset.theme = themeSelect.value;
    });

    fontSizeSelect?.addEventListener("change", () => {
        document.documentElement.dataset.fontSize = fontSizeSelect.value;
    });

    toggles.forEach((button) => {
        if (button.disabled) return;
        button.addEventListener("click", () => {
            setToggleState(button, button.getAttribute("aria-checked") !== "true");
        });
    });

    document.querySelector("[data-settings-save]")?.addEventListener("click", () => {
        const nextPreferences = {
            ...readPreferences(),
            theme: themeSelect?.value || "light",
            fontSize: fontSizeSelect?.value || "default"
        };
        toggles.forEach((button) => {
            nextPreferences[button.dataset.settingToggle] = button.getAttribute("aria-checked") === "true";
        });

        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextPreferences));
        applySavedAppearance();
        showFeedback("Settings saved on this device.");
    });

    document.querySelector("[data-settings-reset]")?.addEventListener("click", () => {
        localStorage.removeItem(STORAGE_KEY);
        document.documentElement.dataset.theme = DEFAULT_PREFERENCES.theme;
        document.documentElement.dataset.fontSize = DEFAULT_PREFERENCES.fontSize;
        if (themeSelect) themeSelect.value = DEFAULT_PREFERENCES.theme;
        if (fontSizeSelect) fontSizeSelect.value = DEFAULT_PREFERENCES.fontSize;
        toggles.forEach((button) => {
            setToggleState(button, DEFAULT_PREFERENCES[button.dataset.settingToggle]);
        });
        showFeedback("Settings restored to defaults.");
    });
}

if (document.querySelector("[data-settings-save]")) {
    initializeSettingsPage();
}