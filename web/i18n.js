let translations = {};

function t(key, defaultText, ...args) {
    let text = translations[key] || defaultText;
    if (args.length > 0) {
        args.forEach((arg, idx) => {
            text = text.replace(`{${idx}}`, arg);
        });
    }
    return text;
}
        
async function loadI18n() {
    let locale = navigator.language.split(/[-_]/)[0];
    try {
        const parentWindow = window.parent !== window ? window.parent : (window.opener && !window.opener.closed ? window.opener : null);
        if (parentWindow && parentWindow.comfyApp && parentWindow.comfyApp.ui) {
            locale = parentWindow.comfyApp.ui.settings.getSettingValue("Comfy.Locale") || "en";
        }
    } catch (e) { console.warn(e); }
    
    if (locale.startsWith("en")) return;
    
    try {
        const cacheBuster = `?t=${new Date().getTime()}`;
        const i18nUrl = new URL(`i18n/${locale}.json${cacheBuster}`, window.location.href).href;
        let res = await fetch(i18nUrl);
        if (res.ok) {
            translations = await res.json();
            applyStaticI18n(); 
        }
    } catch (e) {
        console.warn("Translation load skipped or failed:", e);
    }
}
        
function applyStaticI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (translations[key]) el.innerText = translations[key];
    });
    document.querySelectorAll('[title-i18n]').forEach(el => {
        const key = el.getAttribute('title-i18n');
        if (translations[key]) el.title = translations[key];
    });
    document.querySelectorAll('[placeholder-i18n]').forEach(el => {
        const key = el.getAttribute('placeholder-i18n');
        if (translations[key]) el.placeholder = translations[key];
    });
}