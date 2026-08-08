import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

let i18n = {};
let baseI18n = {
    not_app: "This is not an App workflow!\nPlease configure it using AppBuilder first.",
    save_confirm: "Save changes?",
};

async function loadI18n() {
    const comfyLang = app.ui.settings.getSettingValue("Comfy.Locale");
    const baseUrl = new URL("./i18n/", import.meta.url).href;
    if (comfyLang !== "en") {
        try {
            const responseLang = await fetch(`${baseUrl}${comfyLang}.json`);
            if (responseLang.ok) {
                const langData = await responseLang.json();
                i18n = { ...baseI18n, ...langData };
            } else { i18n = baseI18n; }
        } catch (e) { console.log(e); i18n = baseI18n; }
    } else { i18n = baseI18n; }
}

const findAllNodes = (nodes, type) => {
    let found = [];
    for (const node of nodes) {
        if (!type || node.type === type) found.push(node);
        if (node.subgraph && node.subgraph._nodes) found.push(...findAllNodes(node.subgraph._nodes, type));
        else if (typeof node.getInnerNodes === 'function') {
            try {
                const inner = node.getInnerNodes();
                if (inner) found.push(...findAllNodes(inner, type));
            } catch (e) {}
        }
    }
    return found;
};

function isNodeV2() {
    return app.ui.settings.getSettingValue("Comfy.VueNodes.Enabled");
}

function isMobile() {
    const ua = navigator.userAgent;
    if (/Android|iPhone|iPod/i.test(ua)) return true;
    if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
    return false;
}

function hideWidget(widget) {
    if (!widget) return;
    if (isNodeV2()) {
        widget.disabled = true;
    } else {
        widget.hidden = true;
        widget.type = "converted-widget";
        widget.computeSize = () => [0, -4];
    }
}

async function setupAPI() {
    await loadI18n();
    window.comfyApp = app;
    window.comfyApi = api;
    
    function isComfyuiFullyLoaded() {
        if (!app || !app.graph) return false;
        const isObjectInfoLoaded = typeof LiteGraph !== "undefined" && 
        !!LiteGraph.registered_node_types && 
        (!!LiteGraph.registered_node_types["KSampler"] || !!LiteGraph.registered_node_types["LoadImage"]);
        const isCanvasReady = !!document.querySelector("canvas") || (app.canvas && !!app.canvas.canvas);
        const isMenuReady = !!(document.querySelector(".comfy-menu") || document.querySelector("#comfy-user-button") || document.querySelector(".comfyui-body-left"));
        return isObjectInfoLoaded && isCanvasReady && isMenuReady;
    }
    
    function tryInjectManager() {
        if (isMobile()) {
            if (isComfyuiFullyLoaded()) {
                let wfIframe = document.createElement("iframe");
                wfIframe.id = "app-manager-iframe";
                wfIframe.style.cssText = `
                    position: fixed; top: 0; left: 0;
                    width: 100%; height: 100dvh; z-index: 999998; border: none;
                    pointer-events: auto; background: #121212;
                `;
                const htmlUrl = new URL('app_manager.html', import.meta.url);
                wfIframe.src = htmlUrl.href;
                document.body.appendChild(wfIframe);
            } else {
                setTimeout(tryInjectManager, 300);
            }
        }
    }
    tryInjectManager();
    
    window.addEventListener("message", async (e) => {
        if (e.data && e.data.type === "close_appview") {
            if (isMobile()) await closeActiveWorkflow();
            const iframe = document.getElementById("appview-iframe");
            if (iframe) iframe.remove(); 
        }
        
        if (e.data && e.data.type === "close_app_manager") {
            const iframe = document.getElementById("app-manager-iframe");
            if (iframe) iframe.remove();
        }
        
        if (e.data && e.data.type === "save_workflow") {
            await saveActiveWorkflow();
        }
        
        if (e.data && e.data.type === "load_workflow") {
            const filename = e.data.filename;
            
            try {
                const response = await fetch(`/appbuilder/workflows/get?file=${encodeURIComponent(filename)}`);
                if (response.ok) {
                    const workflowData = await response.json();
                    const nativeFilePath = "app/" + filename;
                    const cleanName = filename.replace(/\.json$/i, "");
                    
                    try {
                        const vueApp = document.querySelector('[data-v-app]')?.__vue_app__;
                        const pinia = vueApp?.config?.globalProperties?.$pinia;
                        if (pinia && pinia._s) {
                            for (const [id, store] of pinia._s.entries()) {
                                if (store && store.workflows) {
                                    const wfs = Array.isArray(store.workflows) ? store.workflows : Object.values(store.workflows);
                                    const ghostWf = wfs.find(w => w && (w.filename === cleanName && w.directory === "workflows/app"));
                                    if (ghostWf) {
                                        ghostWf.originalContent = JSON.stringify(workflowData);
                                        Object.defineProperty(ghostWf, "isLoaded", { get() { return false; }, set(v) {}, configurable: true });
                                        if (!ghostWf.changeTracker) {
                                            ghostWf.changeTracker = {
                                                reset: function(data) { ghostWf._isModified = false; }, 
                                                restore: function() {}, deactivate: function() {}, prepareForSave: function() {}, captureCanvasState: function() {},
                                                get activeState() { return app.graph ? app.graph.serialize() : workflowData; },
                                                get initialState() { return workflowData; }
                                            };
                                        }
                                    }
                                }
                            }
                        }
                    } catch (err) { console.warn("Pre-load check failed:", err); }
                    
                    await app.loadGraphData(workflowData, true, true, nativeFilePath);
                    if (app.ui && typeof app.ui.setFilename === "function") app.ui.setFilename(cleanName);
                    if (app.graph) app.graph.filename = filename;
                    
                    setTimeout(() => {
                        try {
                            const vueApp = document.querySelector('[data-v-app]')?.__vue_app__;
                            if (vueApp) {
                                const pinia = vueApp.config.globalProperties.$pinia;
                                let wfStore = pinia.state.value?.workflow || pinia.state.value?.workflowStore;
                                if (!wfStore) {
                                    for (const key in pinia.state.value || {}) {
                                        if (pinia.state.value[key]?.activeWorkflow !== undefined) {
                                            wfStore = pinia.state.value[key]; break;
                                        }
                                    }
                                }
                                if (wfStore && wfStore.activeWorkflow) {
                                    const wf = wfStore.activeWorkflow;
                                    wf.name = cleanName; wf.fullFilename = filename; wf.directory = "workflows/app"; wf.path = "workflows/app/" + filename;
                                    Object.defineProperty(wf, "isPersisted", { get() { return true; }, set(v) {}, configurable: true });
                                    Object.defineProperty(wf, "isLoaded", { get() { return true; }, set(v) {}, configurable: true });
                                    wf.originalContent = JSON.stringify(workflowData); wf._isModified = false;
                                    if (!wf.changeTracker) {
                                        wf.changeTracker = {
                                            reset: function(data) { wf._isModified = false; }, restore: function() {}, deactivate: function() {}, prepareForSave: function() {}, captureCanvasState: function() {},
                                            get activeState() { return app.graph ? app.graph.serialize() : workflowData; }, get initialState() { return workflowData; }
                                        };
                                    }
                                }
                            }
                        } catch (err) {}
                    }, 500); 
                    
                    setTimeout(() => {
                        const firstBuilder = app.graph.findNodesByType("AppBuilder")[0] || app.graph.findNodesByType("AppBuilderAdv")[0];
                        const manager = document.getElementById("app-manager-iframe");
                        if (firstBuilder) {
                            const btnAppView = firstBuilder.widgets?.find(w => w.is_appview_button);
                            if (btnAppView && btnAppView.callback) btnAppView.callback();
                            if (manager && manager.contentWindow) {
                                setTimeout(() => {manager.contentWindow.postMessage({ type: "hide_splash" }, "*"); }, 1000); 
                            }
                        } else {
                            alert(i18n.not_app);
                            if (manager && manager.contentWindow) manager.contentWindow.postMessage({ type: "hide_splash" }, "*");
                        }
                    }, 600); 
                }
            } catch (err) { console.error("Auto load workflow failed:", err); }
        }
    });
    
    if (!api._queuePromptPatched) {
        api._queuePromptPatched = true;
        const originalQueuePrompt = api.queuePrompt;
        api.queuePrompt = async function() {
            try {
                return await originalQueuePrompt.apply(this, arguments);
            } catch (err) {
                let detailedMessage = err.message || String(err);
                if (err.response) {
                    try {
                        const errorData = err.response.error;
                        const nodeErrors = err.response.node_errors;
                        let details = [];
                        if (errorData && errorData.message) details.push(errorData.message);
                        if (nodeErrors) {
                            for (const [nodeId, nodeInfo] of Object.entries(nodeErrors)) {
                                if (nodeInfo.errors && nodeInfo.errors.length > 0) {
                                    nodeInfo.errors.forEach(e => {
                                        const nodeDef = app.graph.getNodeById(nodeId);
                                        const nodeTitle = nodeDef?.title || nodeInfo.class_type || `Node ${nodeId}`;
                                        details.push(`[${nodeTitle}]: ${e.message} (${e.details})`);
                                    });
                                }
                            }
                        }
                        if (details.length > 0) detailedMessage = details.join('\n');
                    } catch (parseErr) {}
                }
                const nodes = [...app.graph.findNodesByType("AppBuilderAdv"), ...app.graph.findNodesByType("AppBuilder")];
                nodes.forEach(node => {
                    if (node.appWindow && !node.appWindow.closed) { node.appWindow.postMessage({ type: 'pre_queue_error', message: detailedMessage }, '*'); }
                });
                throw err;
            }
        };
    }
}

const applyBypasser = (v, params, graph) => {
    if (!graph || !graph._nodes) return;
    const nodes = findAllNodes(graph._nodes, null);
    const tIds = params.match_id ? (Array.isArray(params.match_id) ? params.match_id : [params.match_id]).map(String) : null;
    const tTitles = params.match_title ? (Array.isArray(params.match_title) ? params.match_title : [params.match_title]).map(String) : null;
    const tGroups = params.match_group ? (Array.isArray(params.match_group) ? params.match_group : [params.match_group]).map(String) : null;
    
    const groupMatchedNodeIds = new Set();
    if (tGroups) {
        const collectFromGraph = (g) => {
            if (!g) return;
            if (g._groups) {
                g._groups.forEach(grp => {
                    if (tGroups.includes(String(grp.title).trim())) {
                        grp.recomputeInsideNodes();
                        if (grp._nodes) grp._nodes.forEach(n => groupMatchedNodeIds.add(String(n.id)));
                    }
                });
            }
            if (g._nodes) g._nodes.forEach(n => { if (n.subgraph) collectFromGraph(n.subgraph) });
        };
        collectFromGraph(graph);
    }
                
    nodes.forEach(n => {
        let match = false;
        const nid = String(n.id);
        const ntitle = String(n.title || n.type);
        if (tIds && tIds.includes(nid)) match = true;
        if (tTitles && tTitles.includes(ntitle)) match = true;
        if (tGroups && groupMatchedNodeIds.has(nid)) match = true;
        if (match) n.mode = v ? 0 : 4; 
    });
};

const saveWidgetValueToConfig = (node, key, val) => {
    const jsonW = node.widgets?.find(w => w.name === "config_json");
    if (jsonW && jsonW.value) {
        try {
            const config = JSON.parse(jsonW.value);
            if (config[key]) {
                config[key].value = val;
                jsonW.value = JSON.stringify(config);
                if (node.widgets_values && Array.isArray(node.widgets_values)) {
                    const idx = node.widgets.indexOf(jsonW);
                    if (idx !== -1) node.widgets_values[idx] = jsonW.value;
                }
            }
        } catch(e) {}
    }
};

const notifyConnectedAppBuilder = (bypasserNode) => {
    if (!bypasserNode || !bypasserNode.outputs) return;
    const output = bypasserNode.outputs[0];
    if (output && output.links) {
        output.links.forEach(linkId => {
            const link = app.graph.links[linkId];
            if (link) {
                const targetNode = app.graph.getNodeById(link.target_id);
                if (targetNode && typeof targetNode.syncAllConnections === "function") { targetNode.syncAllConnections(); }
            }
        });
    }
};

const setupUploaderWidget = (node, key, param, defaultVal, validKeys) => {
    let inputFiles = ["None"];
    if (app.node_defs && app.node_defs["LoadImage"]) { 
        inputFiles = app.node_defs["LoadImage"].input.required.image[0]; 
    } else if (defaultVal) { 
        inputFiles = [defaultVal]; 
    }
    
    let comboWidget = node.widgets?.find(w => w.name === key);
    if (!comboWidget) {
        comboWidget = node.addWidget("combo", key, defaultVal || inputFiles[0], ()=>{
            if (typeof node.notifyUnpackers === "function") node.notifyUnpackers();
        }, { values: inputFiles });
    } else {
        if (!comboWidget.options) comboWidget.options = {}; 
        comboWidget.options.values = inputFiles;
    }
    comboWidget.label = param.name || key;
    
    // 🌟 核心修复 1：按 associatedKey 精准匹配属于本 Uploader 的专属按钮，绝不与其他 Uploader 共享按钮！
    let uploadBtn = node.widgets?.find(w => w.associatedKey === key);
    const btnDefaultLabel = `Choose ${param.name || key}`;
    
    if (!uploadBtn) {
        uploadBtn = node.addWidget("button", btnDefaultLabel, "Upload", function() {
            const selfBtn = this; // 🌟 核心修复 2：锁定当前按钮的专属引用
            const fileInput = document.createElement("input");
            fileInput.type = "file";
            const mediaType = param.media || 'image';
            if (mediaType === 'image') fileInput.accept = 'image/*';
            else if (mediaType === 'video') fileInput.accept = 'video/*';
            else if (mediaType === 'audio') fileInput.accept = 'audio/*';
            else fileInput.accept = 'image/*,video/*,audio/*';
            
            fileInput.onchange = async () => {
                if (fileInput.files.length > 0) {
                    const file = fileInput.files[0];
                    selfBtn.label = "Uploading...";
                    node.setDirtyCanvas(true, true);
                    const formData = new FormData(); 
                    formData.append("image", file);
                    try {
                        const response = await fetch("/upload/image", { method: "POST", body: formData });
                        if (response.ok) {
                            const result = await response.json();
                            if (comboWidget.options && comboWidget.options.values) {
                                if (!comboWidget.options.values.includes(result.name)) { 
                                    comboWidget.options.values.push(result.name); 
                                }
                            }
                            comboWidget.value = result.name; 
                            selfBtn.label = "Success ✅";
                            if (comboWidget.callback) comboWidget.callback(result.name);
                            if (typeof node.notifyUnpackers === "function") node.notifyUnpackers();
                        } else { 
                            selfBtn.label = "Failed ❌"; 
                        }
                    } catch (e) { 
                        selfBtn.label = "Error ❌"; 
                    }
                    node.setDirtyCanvas(true, true);
                    setTimeout(() => { 
                        selfBtn.label = btnDefaultLabel; 
                        node.setDirtyCanvas(true, true); 
                    }, 1200);
                }
            };
            fileInput.click();
        });
        uploadBtn.associatedKey = key; 
        uploadBtn.serialize = false;
    } else {
        uploadBtn.label = btnDefaultLabel;
    }
    return comboWidget;
};
                
function getActiveWorkflow() {
    const vueApp = document.querySelector('[data-v-app]')?.__vue_app__;
    const pinia = vueApp?.config.globalProperties.$pinia;
    if (!pinia) return null;
    for (const store of Object.values(pinia.state.value)) {
        if (store.activeWorkflow) return store.activeWorkflow;
    }
    return null;
}

const saveActiveWorkflow = async () => {
    try {
        const wf = getActiveWorkflow()
        if (wf) {
            const isAppWorkflow = wf.directory === "workflows/app";
            if (isAppWorkflow) {
                const serializedState = app.graph.serialize();
                const cleanStateStr = JSON.stringify(app.graph.serialize());
                const hasZeroNodes = !app.graph._nodes || app.graph._nodes.length === 0;
                if (!serializedState || cleanStateStr === "null" || hasZeroNodes) { return; }
                await wf.save();
            }
        }
    } catch (e) {}
}
                
const closeActiveWorkflow = async () => {
    try {
        const vueApp = document.querySelector('[data-v-app]')?.__vue_app__;
        const pinia = vueApp?.config?.globalProperties?.$pinia;
        if (pinia && pinia._s) {
            let wfStoreInstance = null;
            for (const [id, instance] of pinia._s.entries()) {
                if (instance && instance.activeWorkflow !== undefined) { wfStoreInstance = instance; break; }
            }
            if (wfStoreInstance) {
                const openWorkflows = wfStoreInstance.openWorkflows || wfStoreInstance.workflows || [];
                const activeWf = wfStoreInstance.activeWorkflow;
                if (openWorkflows.length > 1 && activeWf) {
                    if (typeof wfStoreInstance.closeWorkflow === "function") { await wfStoreInstance.closeWorkflow(activeWf); }
                }
            }
        }
    } catch(err) {}
};
                
function openAppViewIframe(node) {
    const htmlUrl = new URL('app_view.html', import.meta.url);
    htmlUrl.searchParams.set('nodeId', node.id);
    const oldIframe = document.getElementById("appview-iframe");
    if (oldIframe) oldIframe.remove();
    
    const iframe = document.createElement("iframe");
    iframe.id = "appview-iframe";
    Object.assign(iframe.style, {
        position: "fixed", top: "0", left: "0", bottom: "0", width: "100%", height: "100dvh",
        zIndex: "999999", border: "none", opacity: "0", transition: "opacity 0.3s ease", 
        backgroundColor: localStorage.getItem('appview_theme') === 'light' ? '#fafafa' : '#000000',
    });
    
    document.body.appendChild(iframe);
    iframe.src = htmlUrl.href;
    iframe.onload = function() { iframe.style.opacity = "1"; };
    setTimeout(() => { iframe.style.opacity = "1"; }, 500);
    return iframe;
}

function setupAppWindowBridge(context, api) {
    const eventConfigs = [
        { apiEvent: "b_preview", msgType: "b_preview", payload: (e) => ({ blob: e.detail }) },
        { apiEvent: "executed", msgType: "executed", payload: (e) => ({ detail: e.detail }) },
        { apiEvent: "execution_start", msgType: "execution_start" },
        { apiEvent: "status", msgType: "status", payload: (e) => ({ detail: e.detail }) },
        { apiEvent: "execution_interrupted", msgType: "execution_interrupted" },
        { apiEvent: "progress", msgType: "progress", payload: (e) => ({ detail: e.detail }) },
        { apiEvent: "execution_error", msgType: "execution_error", payload: (e) => ({ detail: e.detail }) },
        { apiEvent: "executing", msgType: "executing", payload: (e) => ({ detail: e.detail }) },
        { apiEvent: "appbuilder_log", msgType: "appbuilder_log", payload: (e) => ({ detail: e.detail }) },
    ];
    
    const removeListeners = () => {
        if (context._bridgeHandlers) {
            context._bridgeHandlers.forEach(({ apiEvent, handler }) => { api.removeEventListener(apiEvent, handler); });
            context._bridgeHandlers = null;
        }
    };
    
    context.registerAppWindow = (appWin) => {
        context.appWindow = appWin;
        removeListeners();
        context._bridgeHandlers = eventConfigs.map(({ apiEvent, msgType, payload }) => {
            const handler = (e) => {
                if (context.appWindow && !context.appWindow.closed) {
                    const extraData = payload ? payload(e) : {};
                    context.appWindow.postMessage({ type: msgType, ...extraData }, '*');
                }
            };
            api.addEventListener(apiEvent, handler);
            return { apiEvent, handler };
        });
    };
    
    const originalOnRemoved = context.onRemoved;
    context.onRemoved = function (...args) {
        removeListeners();
        if (originalOnRemoved) { originalOnRemoved.apply(this, args); }
    };
}

function openConfigOverlay(nodeId) {
    if (document.querySelector('.config-modal-overlay')) return;
    const overlay = document.createElement('div');
    overlay.className = 'config-modal-overlay';
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0, 0, 0, 0.85); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
        z-index: 99999; display: flex; justify-content: center; align-items: center;
    `;
    const iframe = document.createElement('iframe');
    const htmlUrl = new URL('config_panel.html', import.meta.url);
    htmlUrl.searchParams.set('nodeId', nodeId);
    iframe.src = htmlUrl.href;
    iframe.style.cssText = `
        width: 90vw; height: 90vh; max-width: 920px; max-height: 800px;
        border: 1px solid #333; border-radius: 16px; background: #121212;
        box-shadow: 0 10px 40px rgba(0,0,0,0.8); overflow: hidden;
    `;
    overlay.appendChild(iframe); document.body.appendChild(overlay);
    window.closeConfigOverlay = () => { document.body.removeChild(overlay); delete window.closeConfigOverlay; };
}
                
// 💡【新增函数 1】：递归穿透 Subgraph (子图)，找到内部真实的底层节点与槽位
function resolveInnerTargetSlot(node, slotIndex) {
    if (!node) return null;
    if (node.subgraph && node.subgraph._nodes) {
        const inputSlot = node.inputs ? node.inputs[slotIndex] : null;
        if (inputSlot && inputSlot.link !== null) {
            const innerLink = node.subgraph.links ? node.subgraph.links[inputSlot.link] : null;
            if (innerLink) {
                const innerTargetNode = node.subgraph.getNodeById(innerLink.target_id);
                if (innerTargetNode) {
                    return resolveInnerTargetSlot(innerTargetNode, innerLink.target_slot);
                }
            }
        }
    }
    return { node, slotIndex };
}
                
// 💡【新增函数 2】：深度寻找节点上的 Widget 控件（支持 unet_name_1 -> unet_name 智能匹配）
function findWidgetOnNode(node, slot) {
    if (!node || !node.widgets) return null;
    const slotName = slot.name;
    const slotLabel = slot.label;
    const widgetName = slot.widget?.name;
    
    // 1. 精确名称查找
    let w = node.widgets.find(item => item.name === widgetName || item.name === slotName || item.name === slotLabel);
    if (w) return w;
    
    // 2. 模糊剥离后缀查找 (如 unet_name_1 搜寻 unet_name)
    if (slotLabel) {
        w = node.widgets.find(item => item.name.startsWith(slotLabel) || slotLabel.startsWith(item.name));
        if (w) return w;
    }
    if (slotName) {
        const baseName = slotName.replace(/_\d+$/, ''); // 剥离末尾的 _1
        w = node.widgets.find(item => item.name === baseName || item.name.startsWith(baseName));
        if (w) return w;
    }
    
    return null;
}
                
setupAPI();

app.registerExtension({
    name: "AppBuilder.AppBuilderAdv",
    async setup() {
        const originalGraphToPrompt = app.graphToPrompt;
        app.graphToPrompt = async function () {
            const res = await originalGraphToPrompt.apply(this, arguments);
            const prompt = res.output; 
            try {
                const panelOutputs = {};
                const replaceMap = {};
                for (const [nodeId, node] of Object.entries(prompt)) {
                    if (node.class_type === "AppBuilderAdv") {
                        const configJson = node.inputs?.config_json || "{}";
                        let config = {};
                        try { config = JSON.parse(configJson); } catch(e) {}
                        
                        const entries = Object.entries(config).slice(0, 32).filter(([k, p]) => {
                            const t = (p.type || "STRING").toUpperCase();
                            return t !== "BUTTON" && t !== "BYPASSER";
                        });
                        
                        panelOutputs[nodeId] = {};
                        entries.forEach(([key, params], slotIdx) => {
                            const type = (params.type || "STRING").toUpperCase();
                            if (type === "INPUT") {
                                const rawOpt = params.optional || false;
                                const displayKey = rawOpt ? `${key} (opt)` : key;
                                const inLink = node.inputs[displayKey];
                                if (inLink && Array.isArray(inLink)) { panelOutputs[nodeId][slotIdx] = inLink; } 
                                else {
                                    if (rawOpt) { panelOutputs[nodeId][slotIdx] = null; } 
                                    else { alert(`Validation Error: Required input '${key}' is missing!`); throw new Error(`Required input missing`); }
                                }
                            } else {
                                let val = node.inputs[key];
                                if (val === undefined) val = params.default;
                                if (type === "INT" || type === "SEED") val = Math.round(Number(val));
                                else if (type === "FLOAT") val = Number(val);
                                else if (type === "BOOLEAN" || type === "BYPASSER") val = Boolean(val);
                                else if (type === "STRING" || type === "UPLOADER" || type === "LORA_STACK") val = String(val);
                                panelOutputs[nodeId][slotIdx] = val;
                            }
                        });
                    }
                }
                            
                for (const [nodeId, node] of Object.entries(prompt)) {
                    if (node.class_type === "ParametersUnpacker") {
                        let panelId = null;
                        if (node.inputs) {
                            for (const val of Object.values(node.inputs)) {
                                if (Array.isArray(val) && val.length === 2) { panelId = String(val[0]); break; }
                            }
                        }
                        if (panelId && panelOutputs[panelId]) { replaceMap[nodeId] = panelOutputs[panelId]; }
                    }
                }
                            
                for (const [nodeId, node] of Object.entries(prompt)) {
                    if (node.class_type === "AppBuilderAdv" || node.class_type === "ParametersUnpacker") continue;
                    if (node.inputs) {
                        for (const [inKey, inVal] of Object.entries(node.inputs)) {
                            if (Array.isArray(inVal) && inVal.length === 2) {
                                const sourceId = String(inVal[0]);
                                const sourceSlot = inVal[1];
                                if (replaceMap[sourceId] && replaceMap[sourceId][sourceSlot] !== undefined) {
                                    const replaceVal = replaceMap[sourceId][sourceSlot];
                                    if (replaceVal === null) { delete node.inputs[inKey]; } else { node.inputs[inKey] = replaceVal; }
                                }
                            }
                        }
                    }
                }
                    
                for (const nodeId of Object.keys(prompt)) {
                    if (prompt[nodeId].class_type === "AppBuilderAdv" || prompt[nodeId].class_type === "ParametersUnpacker") {
                        delete prompt[nodeId];
                    }
                }
            } catch(e) {}
            return res; 
        };
    },
    
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AppBuilderAdv") {
            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (info) {
                this.isConfigured = true; 
                if (onConfigure) onConfigure.apply(this, arguments);
                if (info && info.widgets_values) {
                    const savedJson = info.widgets_values[0];
                    this.buildDynamicUI(savedJson, true, info.widgets_values); 
                }
                const autoOpenWidget = this.widgets?.find(w => w.name === "Auto Launch");
                if (autoOpenWidget && typeof autoOpenWidget.value !== "boolean") autoOpenWidget.value = false;
                const showTitleWidget = this.widgets?.find(w => w.name === "Short Title");
                if (showTitleWidget && typeof showTitleWidget.value !== "boolean") showTitleWidget.value = true;
                setTimeout(() => {
                    const autoOpenWidget = this.widgets?.find(w => w.name === "Auto Launch");
                    if (autoOpenWidget && autoOpenWidget.value === true) {
                        const btnAppView = this.widgets?.find(w => w.is_appview_button);
                        if (btnAppView && btnAppView.callback && !isMobile()) { btnAppView.callback(); }
                    }
                }, 500);
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                
                const existingBuilders = [
                    ...(app.graph.findNodesByType("AppBuilder") || []),
                    ...(app.graph.findNodesByType("AppBuilderAdv") || [])
                ].filter(n => n.id !== this.id);
                
                if (existingBuilders.length > 0) {
                    app.extensionManager.toast.add({
                        severity: "warn",
                        summary: "Warning",
                        detail: "Only ONE AppBuilder node is allowed per workflow!",
                        life: 5000
                    });
                    setTimeout(() => {
                        const canvas = app.canvas;
                        app.graph.remove(this);
                        if (canvas.state) {
                            canvas.state.draggingItems = false;
                            canvas.state.draggingCanvas = false;
                        }
                        canvas.current_node = null;
                        if (canvas.pointer) {
                            canvas.pointer.dragStarted = false;
                            canvas.pointer.pointerId = undefined;
                            canvas.pointer.eLastDown = undefined;
                        }
                        canvas.last_mouse_dragging = false;
                        canvas.setDirty(true, true);
                    }, 10);
                    return r;
                }
                
                this.size = [300, 120];
                setupAppWindowBridge(this, api);

                const btnWidget = this.addWidget("button", "📱 Open in AppView", "btn_app_view", () => { openAppViewIframe(this) });
                Object.defineProperty(btnWidget, 'height', { get() { return 40; }, configurable: true });
                btnWidget.computeSize = function(width) { return [width, 40]; };
                btnWidget.is_appview_button = true;
                
                const btnWidget2 = this.addWidget("button", "⚙️ Configure Panel", "btn_configure", () => { openConfigOverlay(this.id); });
                btnWidget2.is_configure_button = true;
                
                this.addWidget("toggle", "Auto Launch", false, (v) => {
                    if (v) {
                        const nodes = [...app.graph.findNodesByType("AppBuilderAdv"), ...app.graph.findNodesByType("AppBuilder")];
                        const otherNodes = nodes.filter(n => n.id !== this.id);
                        otherNodes.forEach(n => {
                            const otherToggle = n.widgets?.find(w => w.name === "Auto Launch");
                            if (otherToggle && otherToggle.value === true) { otherToggle.value = false; if (otherToggle.callback) otherToggle.callback(false); }
                        });
                    }
                }, {});

                setTimeout(() => {
                    const jsonW = this.widgets.find(w => w.name === "config_json"); if (jsonW) hideWidget(jsonW);
                    const prevW = this.widgets.find(w => w.name === "live_preview"); if (prevW) hideWidget(prevW);
                    this.computeSize(); this.setDirtyCanvas(true, true);
                }, 50);

                this.notifyUnpackers = function() {
                    if (!this.outputs || !this.outputs[0].links) return;
                    this.outputs[0].links.forEach(linkId => {
                        const link = app.graph.links[linkId];
                        if (link) {
                            const targetNode = app.graph.getNodeById(link.target_id);
                            if (targetNode && targetNode.type === "ParametersUnpacker") { targetNode.syncFromUpstream(); }
                        }
                    });
                };

                this.buildDynamicUI = async function(customJsonStr = null, isRestoring = false, storedValues = null) {
                    this.imgs = []; this.setDirtyCanvas(true, true);
                    let jsonStr = customJsonStr || this.widgets.find(w => w.name === "config_json")?.value;
                    if (jsonStr === "" || !jsonStr) jsonStr = "{}";

                    let config;
                    try { config = JSON.parse(jsonStr); } catch (e) { return; }
                    const entries = Object.entries(config).slice(0, 32);

                    const isStatic = (w) => (
                        w.name === "config_json" || w.name === "live_preview" || w.is_appview_button || w.is_configure_button ||
                        w.value === "btn_configure" || w.value === "btn_app_view" || w.name === "Auto Launch"
                    );

                    for (let i = this.widgets.length - 1; i >= 0; i--) {
                        if (!isStatic(this.widgets[i])) {
                            if (this.widgets[i].onRemove) this.widgets[i].onRemove();
                            this.widgets.splice(i, 1);
                        }
                    }
                    
                    if (this.inputs) while(this.inputs.length > 0) this.removeInput(this.inputs.length - 1);

                    const oldInputs = [];
                    if (this.inputs) {
                        for (let i = 0; i < this.inputs.length; i++) {
                            const inp = this.inputs[i];
                            if (inp.link) {
                                const l = app.graph.links[inp.link];
                                if (l) { oldInputs.push({ name: inp.name, origin_id: l.origin_id, origin_slot: l.origin_slot }); }
                            }
                        }
                        while(this.inputs.length > 0) { this.removeInput(this.inputs.length - 1); }
                    }

                    for (const [key, params] of entries) {
                        const type = (params.type || "STRING").toUpperCase();
                        let widget;
                        let val = params.value !== undefined ? params.value : params.default;

                        if (type === "INT" || type === "FLOAT") {
                            const isInt = type === "INT";
                            const step = params.step ?? (isInt ? 1 : 0.1);
                            const prec = params.precision ?? (isInt ? 0 : 3);
                            const isSlider = params.slider === true || params.display === "slider";
                            
                            if (isSlider && (params.min === undefined || params.max === undefined)) { continue; }
                            
                            const minVal = params.min ?? -999999; const maxVal = params.max ?? 999999;
                            const initVal = val ?? 0;
                            
                            widget = this.addWidget(isSlider ? "slider" : "number", key, initVal, (v) => {
                                let snapped = isInt ? Math.round(v) : Math.round(v / step) * step;
                                const finalVal = parseFloat(snapped.toFixed(prec));
                                if (widget.value !== finalVal) { widget.value = finalVal; }
                                saveWidgetValueToConfig(this, key, finalVal);
                            }, { min: minVal, max: maxVal, step: isSlider ? step : step * 10, precision: prec });
                        } else if (type === "SEED") {
                            const minVal = params.min ?? 0; const maxVal = params.max ?? 0xffffffffffffffff; const initVal = val ?? params.default ?? 0;
                            ComfyWidgets.INT(this, key, ["INT", { default: initVal, min: minVal, max: maxVal, control_after_generate: true }], app);
                            widget = this.widgets.find(w => w.name === key);
                            if (widget) widget.value = initVal;
                            const companionW = this.widgets.find(w => w.name === "control_after_generate");
                            if (companionW) {
                                if (params.seed_mode) companionW.value = params.seed_mode;
                                companionW.callback = (v) => {
                                    saveWidgetValueToConfig(this, key, widget.value);
                                    // 保存 seed_mode 到 config_json
                                    const jsonW = this.widgets?.find(w => w.name === "config_json");
                                    if (jsonW && jsonW.value) {
                                        try {
                                            const cfg = JSON.parse(jsonW.value);
                                            if (cfg[key]) { cfg[key].seed_mode = v; jsonW.value = JSON.stringify(cfg); }
                                        } catch(e) {}
                                    }
                                };
                            }
                        } else if (type === "STRING") {
                            if (params.multiline || params.placeholder) {
                                ComfyWidgets.STRING(this, key, ["STRING", { multiline: !!params.multiline, default: val || "" }], app);
                                widget = this.widgets[this.widgets.length - 1];
                                if (widget) {
                                    widget.value = val || "";
                                    widget.callback = (v) => saveWidgetValueToConfig(this, key, v);
                                    if (widget.inputEl) {
                                        if (params.placeholder) widget.inputEl.placeholder = params.placeholder;
                                        widget.inputEl.addEventListener("input", (e) => { saveWidgetValueToConfig(this, key, e.target.value); });
                                    }
                                }
                            } else { widget = this.addWidget("text", key, val || "", (v) => saveWidgetValueToConfig(this, key, v), {}); }
                        } else if (type === "LORA_STACK") {
                            widget = this.addWidget("text", key, val || "[]", (v) => saveWidgetValueToConfig(this, key, v), { read_only: true });
                            if (widget) {
                                widget.disabled = true;
                                widget.options = widget.options || {};
                                widget.options.read_only = true;
                            }
                        } else if (type === "COMBO") {
                            let values = params.values || ["None"];
                            if (params.folder) {
                                try {
                                    const response = await fetch(`/appbuilder/ls/${params.folder}`);
                                    if (response.ok) { const data = await response.json(); values = ["None", ...data]; }
                                } catch (e) {}
                            }
                            widget = this.addWidget("combo", key, val || values[0], (v) => saveWidgetValueToConfig(this, key, v), { values: values });
                        } else if (type === "BOOLEAN") {
                            widget = this.addWidget("toggle", key, val ?? true, (v) => saveWidgetValueToConfig(this, key, v), {});
                        } else if (type === "BYPASSER") {
                            const applyMuter = (v) => {
                                const nodes = findAllNodes(app.graph._nodes, null); 
                                const tIds = params.match_id ? (Array.isArray(params.match_id) ? params.match_id : [params.match_id]).map(String) : null;
                                const tTitles = params.match_title ? (Array.isArray(params.match_title) ? params.match_title : [params.match_title]).map(String) : null;
                                const tGroups = params.match_group ? (Array.isArray(params.match_group) ? params.match_group : [params.match_group]).map(String) : null;
                                const groupMatchedNodeIds = new Set();
                                if (tGroups) {
                                    const collectFromGraph = (graph) => {
                                        if (!graph) return;
                                        if (graph._groups) {
                                            graph._groups.forEach(g => {
                                                if (tGroups.includes(String(g.title).trim())) {
                                                    g.recomputeInsideNodes();
                                                    if (g._nodes) g._nodes.forEach(n => groupMatchedNodeIds.add(String(n.id)));
                                                }
                                            });
                                        }
                                        if (graph._nodes) graph._nodes.forEach(n => { if (n.subgraph) collectFromGraph(n.subgraph) });
                                    };
                                    collectFromGraph(app.graph);
                                }
                                nodes.forEach(n => {
                                    let match = false;
                                    const nid = String(n.id); const ntitle = String(n.title || n.type);
                                    if (tIds) match = tIds.includes(nid); if (tTitles) match = tTitles.includes(ntitle); if (tGroups) match = groupMatchedNodeIds.has(nid);
                                    if (match) n.mode = v ? 0 : 4;
                                });
                            };
                            widget = this.addWidget("toggle", key, val, (v) => applyMuter(v), {});
                            setTimeout(() => applyMuter(widget.value), 300);
                        } else if (type === "UPLOADER") {
                            const oldValidKeys = entries.map(([k, p]) => k);
                            widget = setupUploaderWidget(this, key, params, val, oldValidKeys);
                        }  else if (type === "INPUT") {
                            const inputClass = params.class ? String(params.class).toUpperCase() : "*";
                            const isOptional = params.optional ?? false;
                            this.addInput(key, inputClass, {shape: isOptional ? 7 : undefined});
                            
                            const newIdx = this.inputs.length - 1;
                            const backup = oldInputs.find(l => l.name === key);
                            if (backup) {
                                const originNode = app.graph.getNodeById(backup.origin_id);
                                if (originNode) originNode.connect(backup.origin_slot, this, newIdx);
                            }
                        }  else if (type === "BUTTON") {
                            const action = params.action === "stop" ? "stop" : "run";
                            widget = this.addWidget("button", params.name || key, action, () => {
                                if (action === "run") app.queuePrompt(0);
                                else if (action === "stop") api.interrupt();
                            });
                        }
                        if (widget) {
                            const label = params.name || key;
                            widget.label = (type === "LORA_STACK") ? `🔒 ${label}` : label;
                            widget.tooltip = params.tooltip;
                            if (storedValues) {
                                const wIdx = this.widgets.indexOf(widget);
                                if (wIdx !== -1 && storedValues[wIdx] !== undefined) widget.value = storedValues[wIdx];
                            }
                        }
                    }
                    
                    if (!isRestoring) this.notifyUnpackers();
                    this.computeSize(); this.setDirtyCanvas(true, true);
                };

                setTimeout(() => {
                    const jsonW = this.widgets.find(w => w.name === "config_json"); if (jsonW) hideWidget(jsonW);
                    const prevW = this.widgets.find(w => w.name === "live_preview"); if (prevW) hideWidget(prevW);
                    if (!this.isConfigured) this.buildDynamicUI(null, true);
                }, 100);
                return r;
            };
        }
        
        if (nodeData.name === "ParametersUnpacker") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                this.outputs = []; this.size = [200, 40];
                
                // 🔥【修复的核心方法】：智能同步并保持连线完好
                this.syncFromUpstream = function() {
                    // 如果根本没有输入连线，清空输出槽
                    if (!this.inputs || !this.inputs[0].link) {
                        if (this.outputs && this.outputs.length > 0) { 
                            for (let i = 0; i < this.outputs.length; i++) this.disconnectOutput(i); 
                            this.outputs = []; this.computeSize(); this.setDirtyCanvas(true, true); 
                        }
                        return;
                    }
                    
                    const linkId = this.inputs[0].link; 
                    const link = app.graph ? app.graph.links[linkId] : null; 
                    if (!link) return; // 连线还没加载完成，直接返回，绝不断开已有的输出！

                    const upstreamNode = app.graph.getNodeById(link.origin_id); 
                    if (!upstreamNode || upstreamNode.type !== "AppBuilderAdv") return;

                    const jsonWidget = upstreamNode.widgets?.find(w => w.name === "config_json"); 
                    if (!jsonWidget || !jsonWidget.value) return; // 上游节点尚未构建完毕，直接返回！

                    let config;
                    try { config = JSON.parse(jsonWidget.value || "{}"); } catch (e) { return; }
                    const entries = Object.entries(config).slice(0, 32);
                    const outputEntries = entries.filter(([k, p]) => {
                        const t = (p.type || "STRING").toUpperCase(); return t !== "BUTTON" && t !== "BYPASSER";
                    });

                    // 校验现有输出槽是否和上游配置完全一致
                    const currentOutputs = this.outputs || [];
                    let needsUpdate = currentOutputs.length !== outputEntries.length;
                    if (!needsUpdate) {
                        for (let i = 0; i < outputEntries.length; i++) {
                            const [key] = outputEntries[i];
                            if (currentOutputs[i].name !== key) {
                                needsUpdate = true; break;
                            }
                        }
                    }

                    // 💡【核心修复点】：如果输出槽数量和 Key 都没变（即常规加载工作流），只更新标签和类型，绝不销毁/断开连线！
                    if (!needsUpdate) {
                        outputEntries.forEach(([key, params], idx) => {
                            const baseType = (params.type || "*").toUpperCase();
                            let outputClass;
                            if (params.class) { outputClass = String(params.class).toUpperCase() } 
                            else if (baseType === "INPUT") { outputClass = "*"; } 
                            else if (baseType === "SEED") { outputClass = "INT"; } 
                            else if (baseType === "UPLOADER") { outputClass = "COMBO"; } 
                            else if (baseType === "LORA_STACK") { outputClass = "STRING"; } 
                            else { outputClass = baseType; }

                            const displayName = params.name || key;
                            if (this.outputs[idx]) {
                                this.outputs[idx].type = outputClass;
                                this.outputs[idx].label = displayName;
                            }
                        });
                        this.setDirtyCanvas(true, true);
                        return;
                    }

                    // 只有在配置真正发生修改（增删配置项）时，才安全备份并重建
                    const oldLinks = [];
                    if (this.outputs) {
                        for (let i = 0; i < this.outputs.length; i++) {
                            const output = this.outputs[i];
                            if (output.links && output.links.length > 0) {
                                const linksInfo = output.links.map(lId => {
                                    const l = app.graph ? app.graph.links[lId] : null;
                                    if (!l) return null;
                                    const targetNode = app.graph.getNodeById(l.target_id);
                                    return targetNode ? { targetNode, target_slot: l.target_slot } : null;
                                }).filter(Boolean);
                                oldLinks.push({ name: output.name, connections: linksInfo });
                                this.disconnectOutput(i);
                            }
                        }
                    }

                    this.outputs = [];
                    outputEntries.forEach(([key, params], idx) => {
                        const baseType = (params.type || "*").toUpperCase();
                        let outputClass;
                        if (params.class) { outputClass = String(params.class).toUpperCase() } 
                        else if (baseType === "INPUT") { outputClass = "*"; } 
                        else if (baseType === "SEED") { outputClass = "INT"; } 
                        else if (baseType === "UPLOADER") { outputClass = "COMBO"; } 
                        else if (baseType === "LORA_STACK") { outputClass = "STRING"; } 
                        else { outputClass = baseType; }

                        const displayName = params.name || key; const isOptional = params.optional ?? false;
                        this.addOutput(key, outputClass, {shape: isOptional ? 7 : undefined});
                        const newOutput = this.outputs[this.outputs.length - 1]; newOutput.label = displayName;

                        const backup = oldLinks.find(l => l.name === key);
                        if (backup) {
                            backup.connections.forEach(conn => {
                                if (conn.targetNode) {
                                    this.connect(idx, conn.targetNode, conn.target_slot);
                                }
                            });
                        }
                    });
                    this.setSize(this.computeSize()); this.setDirtyCanvas(true, true);
                };
                return r;
            };

            const onConnectionsChange = nodeType.prototype.onConnectionsChange;
            nodeType.prototype.onConnectionsChange = function (type, slotIndex, isConnected, linkInfo) {
                if (onConnectionsChange) onConnectionsChange.apply(this, arguments);
                if (type === 1 && slotIndex === 0) { setTimeout(() => this.syncFromUpstream(), 50); }
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                if (onConfigure) onConfigure.apply(this, arguments);
                setTimeout(() => this.syncFromUpstream(), 100);
            };
        }
    }
});


app.registerExtension({
    name: "AppBuilder.AppBuilder",
    setup() {
        const originalGraphToPrompt = app.graphToPrompt;
        app.graphToPrompt = async function () {
            const res = await originalGraphToPrompt.apply(this, arguments);
            const prompt = res.output; 
            try {
                const builderNodes = app.graph.findNodesByType("AppBuilder");
                const panelData = {};
                builderNodes.forEach(node => {
                    const nodeId = String(node.id); panelData[nodeId] = {};
                    let config = {};
                    const jsonW = node.widgets?.find(w => w.name === "config_json");
                    if (jsonW && jsonW.value) { try { config = JSON.parse(jsonW.value); } catch(e) {} }
                    Object.entries(config).forEach(([key, param]) => {
                        const slotIdx = param._slot; if (slotIdx === undefined) return;
                        const targetWidget = node.widgets?.find(w => w.name === key);
                        let val = targetWidget ? targetWidget.value : param.default;
                        if (param.type === "INT" || param.type === "SEED") val = Math.round(Number(val));
                        else if (param.type === "FLOAT") val = Number(val);
                        panelData[nodeId][slotIdx] = val;
                    });
                });

                for (const [nodeId, promptNode] of Object.entries(prompt)) {
                    if (promptNode.class_type === "AppBuilder") continue;
                    if (promptNode.inputs) {
                        for (const [inKey, inVal] of Object.entries(promptNode.inputs)) {
                            if (Array.isArray(inVal) && inVal.length === 2) {
                                const sourceId = String(inVal[0]); const sourceSlot = inVal[1];
                                if (panelData[sourceId] !== undefined) {
                                    const valToInject = panelData[sourceId][sourceSlot];
                                    if (valToInject !== undefined) promptNode.inputs[inKey] = valToInject;
                                    else delete promptNode.inputs[inKey];
                                }
                            }
                        }
                    }
                }
                    
                for (const nodeId of Object.keys(prompt)) {
                    if (["AppBuilder", "AppBuilderBypasser"].includes(prompt[nodeId].class_type)) { delete prompt[nodeId]; }
                }
            } catch(e) {}
            return res; 
        };
    },

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AppBuilderBypasser") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                this.addInput("node_1", "*"); this.size = [220, 80];
                setTimeout(() => {
                    const groupWidget = this.widgets?.find(w => w.name === "group_name");
                    if (groupWidget) { groupWidget.callback = () => notifyConnectedAppBuilder(this); }
                    const nameWidget = this.widgets?.find(w => w.name === "bypasser_name");
                    if (nameWidget) { nameWidget.callback = () => notifyConnectedAppBuilder(this); }
                }, 100);
                return r;
            };

            const onConnectionsChange = nodeType.prototype.onConnectionsChange;
            nodeType.prototype.onConnectionsChange = function (type, slotIndex, isConnected, linkInfo) {
                if (onConnectionsChange) onConnectionsChange.apply(this, arguments);
                if (type === 1) { 
                    let hasEmpty = false;
                    for (let i = this.inputs.length - 1; i >= 0; i--) {
                        if (this.inputs[i].name.startsWith("node_")) {
                            if (!this.inputs[i].link) {
                                if (hasEmpty) this.removeInput(i); else hasEmpty = true;
                            }
                        }
                    }
                    if (!hasEmpty) this.addInput(`node_${this.inputs.length + 1}`, "*");
                    this.setSize(this.computeSize());
                }
                setTimeout(() => { notifyConnectedAppBuilder(this); }, 100);
            };
            nodeType.prototype.onWidgetChanged = function (name) {
                if (name === "group_name" || name === "bypasser_name") notifyConnectedAppBuilder(this);
            };
        }
        
        if (nodeData.name === "AppBuilder") {
            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (info) {
                if (onConfigure) onConfigure.apply(this, arguments);
                const autoOpenWidget = this.widgets?.find(w => w.name === "Auto Launch");
                if (autoOpenWidget && typeof autoOpenWidget.value !== "boolean") autoOpenWidget.value = false;
                const showTitleWidget = this.widgets?.find(w => w.name === "Short Title");
                if (showTitleWidget && typeof showTitleWidget.value !== "boolean") showTitleWidget.value = true;
                setTimeout(() => {
                    const autoOpenWidget = this.widgets?.find(w => w.name === "Auto Launch");
                    if (autoOpenWidget && autoOpenWidget.value === true) {
                        const btnAppView = this.widgets?.find(w => w.is_appview_button);
                        if (btnAppView && btnAppView.callback && !isMobile()) { btnAppView.callback(); }
                    }
                }, 500); 
            };
            
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                
                const existingBuilders = [
                    ...(app.graph.findNodesByType("AppBuilder") || []),
                    ...(app.graph.findNodesByType("AppBuilderAdv") || [])
                ].filter(n => n.id !== this.id);
                
                if (existingBuilders.length > 0) {
                    app.extensionManager.toast.add({
                        severity: "warn",
                        summary: "Warning",
                        detail: "Only ONE AppBuilder node is allowed per workflow!",
                        life: 5000
                    });
                    setTimeout(() => {
                        const canvas = app.canvas;
                        app.graph.remove(this);
                        if (canvas.state) {
                            canvas.state.draggingItems = false;
                            canvas.state.draggingCanvas = false;
                        }
                        canvas.current_node = null;
                        if (canvas.pointer) {
                            canvas.pointer.dragStarted = false;
                            canvas.pointer.pointerId = undefined;
                            canvas.pointer.eLastDown = undefined;
                        }
                        canvas.last_mouse_dragging = false;
                        canvas.setDirty(true, true);
                    }, 10);
                    return r;
                }
                
                this.size = [300, 100];
                this.addInput("bypasser_1", "BYPASSER", { shape: 7 });
                setupAppWindowBridge(this, api);
                
                setTimeout(() => {
                    const jsonW = this.widgets.find(w => w.name === "config_json"); if (jsonW) { hideWidget(jsonW); }
                }, 50);
                
                const btnWidget = this.addWidget("button", "📱 Open in AppView", "btn_app_view", () => {
                    this.syncAllConnections(); openAppViewIframe(this);
                });
                Object.defineProperty(btnWidget, 'height', { get() { return 40; }, configurable: true });
                btnWidget.computeSize = function(width) { return [width, 40]; };
                btnWidget.is_appview_button = true;
                
                this.addWidget("toggle", "Auto Launch", false, (v) => {
                    if (v) {
                        const nodes = [...app.graph.findNodesByType("AppBuilderAdv"), ...app.graph.findNodesByType("AppBuilder")];
                        const otherNodes = nodes.filter(n => n.id !== this.id);
                        otherNodes.forEach(n => {
                            const otherToggle = n.widgets?.find(w => w.name === "Auto Launch");
                            if (otherToggle && otherToggle.value === true) { otherToggle.value = false; if (otherToggle.callback) otherToggle.callback(false); }
                        });
                    }
                }, {});
                
                this.addWidget("toggle", "Short Title", false, (v) => { this.syncAllConnections(); }, {});
                
                if (this.inputs) {
                    for (let i = this.inputs.length - 1; i >= 0; i--) {
                        if (this.inputs[i].name === "config_json") { this.removeInput(i); }
                    }
                }
                return r;
            };

            const onConnectionsChange = nodeType.prototype.onConnectionsChange;
            nodeType.prototype.onConnectionsChange = function (type, slotIndex, isConnected, linkInfo) {
                if (onConnectionsChange) onConnectionsChange.apply(this, arguments);
                if (type === 1) { 
                    let hasEmpty = false;
                    for (let i = this.inputs.length - 1; i >= 0; i--) {
                        if (this.inputs[i].name.startsWith("bypasser_")) {
                            if (!this.inputs[i].link) { if (hasEmpty) this.removeInput(i); else hasEmpty = true; }
                        }
                    }
                    if (!hasEmpty) {
                        let nextIdx = 1;
                        while(this.inputs.find(inp => inp.name === `bypasser_${nextIdx}`)) nextIdx++;
                        this.addInput(`bypasser_${nextIdx}`, "BYPASSER", { shape: 7 });
                    }
                }
                setTimeout(() => this.syncAllConnections(), 50);
            };

            nodeType.prototype.syncAllConnections = function() {
                if (this.inputs) {
                    for (let i = this.inputs.length - 1; i >= 0; i--) {
                        if (this.inputs[i].name === "config_json") { this.removeInput(i); }
                    }
                }
                
                const jsonW = this.widgets?.find(w => w.name === "config_json");
                let oldConfig = {};
                if (jsonW && jsonW.value) {
                    try { oldConfig = JSON.parse(jsonW.value); } catch(e) {}
                }
                
                let hasEmptyOutput = false;
                for (let i = this.outputs.length - 1; i >= 0; i--) {
                    const output = this.outputs[i];
                    if (!output.links || output.links.length === 0) {
                        if (hasEmptyOutput) { this.removeOutput(i); } else { hasEmptyOutput = true; }
                    }
                }
                
                if (!hasEmptyOutput) this.addOutput(`any`, "*");
                this.outputs.forEach((output, idx) => { output.name = "any"; });
                
                let config = {}; let validKeys = [];

                this.outputs.forEach((output, outIdx) => {
                    if (output.name !== "any" || !output.links || output.links.length === 0) return; 
                    const link = app.graph.links[output.links[0]]; if (!link) return;
                    let targetNode = app.graph.getNodeById(link.target_id); if (!targetNode || !targetNode.inputs) return;
                    let targetSlotIdx = link.target_slot;
                    
                    // 1. 穿透 Subgraph (子图) 寻找内部真实节点
                    const resolved = resolveInnerTargetSlot(targetNode, targetSlotIdx);
                    if (resolved && resolved.node) {
                        targetNode = resolved.node;
                        targetSlotIdx = resolved.slotIndex;
                    }
                    
                    const targetSlot = targetNode.inputs[targetSlotIdx];
                    if (!targetSlot) return;
                    const targetSlotName = targetSlot.name;
                    
                    let pType = "STRING";
                    let pOpts = {};
                    let pValues = undefined;
                    let isSupported = false;
                    let pythonPresetStep = undefined; 
                    
                    const shortTitleWidget = this.widgets?.find(w => w.name === "Short Title");
                    const shortTitle = shortTitleWidget ? shortTitleWidget.value : false;
                    const displayName = shortTitle ? targetSlotName : `${targetSlotName} (${targetNode.title || targetNode.type})`;
                    
                    const liveWidget = findWidgetOnNode(targetNode, targetSlot);
                    
                    // 🛡️ 第一层校验：直接检查 targetSlot 槽位本身声明的类型
                    if (targetSlot) {
                        const rawType = targetSlot.type;
                        if (Array.isArray(rawType)) {
                            pType = "COMBO"; pValues = rawType; isSupported = true;
                        } else if (typeof rawType === "string") {
                            const uType = rawType.toUpperCase();
                            if (["INT", "FLOAT", "BOOLEAN", "STRING", "COMBO"].includes(uType)) {
                                pType = uType; isSupported = true;
                            } else if (uType === "NUMBER") {
                                pType = "FLOAT"; isSupported = true;
                            } else if (uType === "*" || uType === "") {
                                pType = "STRING"; isSupported = true; // 允许通配符透传
                            }
                        }
                    }
                    
                    // 🛡️ 第二层校验：从静态节点定义 nodeDefs 查找类型
                    const nodeDefs = app.nodeDefs || app.node_defs || (app.extensionManager ? app.extensionManager.nodeDefs : null);
                    const nodeDef = (nodeDefs ? nodeDefs[targetNode.type] : null) || targetNode.constructor?.nodeData;
                    
                    if (nodeDef && nodeDef.input) {
                        const baseSlotName = targetSlotName.replace(/_\d+$/, ''); // 剥离 _1 后缀
                        let paramDef = nodeDef.input.required?.[targetSlotName] || nodeDef.input.optional?.[targetSlotName] ||
                        nodeDef.input.required?.[baseSlotName] || nodeDef.input.optional?.[baseSlotName] ||
                        (targetSlot.label ? (nodeDef.input.required?.[targetSlot.label] || nodeDef.input.optional?.[targetSlot.label]) : null);
                        
                        if (paramDef) {
                            const typeInfo = paramDef[0]; pOpts = { ...pOpts, ...(paramDef[1] || {}) };
                            if (paramDef[1] && paramDef[1].step !== undefined) pythonPresetStep = paramDef[1].step; // 👈 2. 记录 Python 真实的预设 (如 8)
                            const optionsList = pOpts.options || pOpts.values;
                            
                            if (Array.isArray(typeInfo)) {
                                pType = "COMBO"; pValues = typeInfo; isSupported = true;
                            } else if (typeInfo === "COMBO" || (pOpts && Array.isArray(optionsList))) {
                                pType = "COMBO"; pValues = optionsList; isSupported = true;
                            } else if (["INT", "FLOAT", "BOOLEAN", "STRING"].includes(String(typeInfo).toUpperCase())) {
                                pType = String(typeInfo).toUpperCase(); isSupported = true;
                            }
                        }
                    }
                    
                    // 🛡️ 第三层校验：深度解析 liveWidget 控件本身属性 (包含 converted-widget)
                    if (liveWidget) {
                        const wType = String(liveWidget._origType || liveWidget.type || "").toUpperCase();
                        const opts = liveWidget.options || liveWidget._origOptions || {};
                        const liveOptsList = opts.options || opts.values;
                        
                        pOpts = { ...opts, ...pOpts };
                        
                        if (Array.isArray(liveOptsList) && liveOptsList.length > 0) {
                            pType = "COMBO"; pValues = liveOptsList; isSupported = true;
                        } else if (wType === "TOGGLE" || wType === "BOOLEAN") {
                            pType = "BOOLEAN"; isSupported = true;
                        } else if (wType === "NUMBER" || wType === "SLIDER") {
                            pType = (pOpts.precision === 0 || opts.precision === 0) ? "INT" : "FLOAT";
                            isSupported = true;
                        } else if (wType === "TEXT" || wType === "CUSTOMTEXT" || wType === "STRING" || wType === "CONVERTED-WIDGET") {
                            if (!isSupported) { pType = "STRING"; isSupported = true; }
                        }
                        
                        if (liveWidget.value !== undefined) {
                            pOpts.default = liveWidget.value;
                        }
                    }
                    
                    // 🛡️ 第四层兜底：对于槽位名称包含显式关键词的，直接放行
                    /*const sNameLower = (targetSlotName + " " + (targetSlot.label || "")).toLowerCase();
                    if (!isSupported) {
                        if (sNameLower.includes("text") || sNameLower.includes("prompt") || sNameLower.includes("string") || sNameLower.includes("name")) {
                            pType = "STRING"; isSupported = true;
                        } else if (sNameLower.includes("seed")) {
                            pType = "SEED"; isSupported = true;
                        } else if (sNameLower.includes("step") || sNameLower.includes("width") || sNameLower.includes("height") || sNameLower.includes("batch")) {
                            pType = "INT"; isSupported = true;
                        } else if (sNameLower.includes("cfg") || sNameLower.includes("denoise") || sNameLower.includes("strength")) {
                            pType = "FLOAT"; isSupported = true;
                        }
                    }*/
                    
                    // 💡 智能模型文件夹归类
                    const tClass = String(targetNode.type).toLowerCase();
                    const tSlot = String(targetSlotName).toLowerCase();
                    const sLabel = String(targetSlot.label || "").toLowerCase();
                    
                    if (pType === "COMBO") {
                        isSupported = true;
                        if (tClass.includes("load") && (tSlot.includes("image") || tSlot.includes("video") || tSlot.includes("file"))) {
                            pType = "UPLOADER";
                        } else if (tSlot.includes("unet") || sLabel.includes("unet") || tSlot.includes("diffusion") || sLabel.includes("diffusion")) {
                            pOpts.folder = "diffusion_models";
                        } else if (tSlot.includes("ckpt") || sLabel.includes("ckpt") || tSlot.includes("checkpoint") || sLabel.includes("checkpoint")) {
                            pOpts.folder = "checkpoints";
                        } else if (tSlot.includes("lora") || sLabel.includes("lora")) {
                            pOpts.folder = "loras";
                        } else if (tSlot.includes("vae") || sLabel.includes("vae")) {
                            pOpts.folder = "vae";
                        } else if (tSlot.includes("clip") || sLabel.includes("clip")) {
                            pOpts.folder = "text_encoders";
                        } else if (tSlot.includes("control") || sLabel.includes("control") || tSlot.includes("controlnet")) {
                            pOpts.folder = "controlnet";
                        } else if (tSlot.includes("style") || sLabel.includes("style")) {
                            pOpts.folder = "style_models";
                        } else if (tSlot.includes("gligen") || sLabel.includes("gligen")) {
                            pOpts.folder = "gligen";
                        }
                    } else if (pType === "INT" && (tSlot.includes("seed") || sLabel.includes("seed"))) {
                        pType = "SEED"; isSupported = true;
                    } else if (tClass.includes("lorastack") && (tSlot.includes("lora_stack") || sLabel.includes("lora_stack"))) {
                        pType = "LORA_STACK"; pOpts.folder = "loras";
                        pOpts.min = 1; pOpts.max = 128; isSupported = true;
                    }
                    
                    // ❌ 只有在四层判定全不通过时，才判定为不支持（比如真正的 MODEL / LATENT 物理模型槽位）
                    if (!isSupported) {
                        const illegalType = targetSlot.type || "Unknown";
                        app.extensionManager.toast.add({
                            severity: "warn",
                            summary: "Connection Rejected",
                            detail: `Unsupported type "${illegalType}"`,
                            life: 5000
                        });
                        app.graph.removeLink(link.id); this.setDirtyCanvas(true, true); return; 
                    }
                    
                    const getPrecisionFromStep = (stepVal) => {
                        if (!stepVal || Number.isInteger(stepVal)) return 0;
                        const str = String(stepVal); const decimalIdx = str.indexOf(".");
                        return decimalIdx === -1 ? 0 : str.length - decimalIdx - 1;
                    };
                    
                    let derivedPrecision = undefined;
                    if (pOpts.precision !== undefined) { derivedPrecision = pOpts.precision; } 
                    else if (pOpts.round !== undefined) { derivedPrecision = getPrecisionFromStep(pOpts.round); } 
                    else if (pOpts.step !== undefined) { derivedPrecision = getPrecisionFromStep(pOpts.step); }
                    
                    let key = `${targetNode.title || targetNode.type}_${targetSlotName}`.replace(/[^a-zA-Z0-9_]/g, "_");
                    if (config[key]) key = `${key}_${outIdx}`;
                    
                    let targetLiveValue = undefined;
                    if (liveWidget && liveWidget.value !== undefined) {
                        targetLiveValue = liveWidget.value;
                    }
                    
                    const activeWidget = this.widgets?.find(w => w.name === key);
                    const oldItem = oldConfig?.[key];
                    const isSameNode = Boolean(oldItem && oldItem._node_id !== undefined && oldItem._node_id === targetNode.id);
                    let fallbackValue = targetLiveValue !== undefined ? targetLiveValue : (pOpts.default !== undefined ? pOpts.default : null);
                    const savedValue = (isSameNode && oldConfig[key].value !== undefined) ? oldConfig[key].value : fallbackValue;
                    const activeValue = isSameNode && activeWidget ? activeWidget.value : savedValue;
                    
                    let finalStep = pOpts.step;
                    if (pType === "INT") finalStep = (pythonPresetStep !== undefined && pythonPresetStep !== null) ? pythonPresetStep : 1;

                    config[key] = { 
                        type: pType, 
                        name: displayName, 
                        default: pOpts.default, 
                        value: activeValue, 
                        min: pOpts.min, 
                        max: pOpts.max, 
                        step: finalStep, 
                        precision: derivedPrecision, 
                        display: pOpts.display, 
                        values: pValues, 
                        multiline: !!pOpts.multiline, 
                        _slot: outIdx,
                        _node_id: targetNode.id,
                        folder: pOpts.folder 
                    };
                    if (pType === "SEED" && oldItem && oldItem.seed_mode) config[key].seed_mode = oldItem.seed_mode;
                    validKeys.push(key);
                });

                this.inputs.forEach((input, inIdx) => {
                    if (!input.name.startsWith("bypasser_") || !input.link) return;
                    const link = app.graph.links[input.link];
                    const originNode = app.graph.getNodeById(link.origin_id);
                    if (!originNode || originNode.type !== "AppBuilderBypasser") return;

                    const nameWidget = originNode.widgets?.find(w => w.name === "bypasser_name");
                    const bypasserName = nameWidget ? nameWidget.value.trim() : "";
                    const groupWidget = originNode.widgets?.find(w => w.name === "group_name");
                    const groupName = groupWidget ? groupWidget.value.trim() : "";
                    const matchIds = originNode.inputs.filter(inp => inp.name.startsWith("node_") && inp.link).map(inp => String(app.graph.links[inp.link].origin_id));

                    let key = `Bypasser_In_${inIdx}`;
                    const activeWidget = this.widgets?.find(w => w.name === key);
                    const savedValue = (oldConfig[key] && oldConfig[key].value !== undefined) ? oldConfig[key].value : true;
                    const activeValue = activeWidget ? activeWidget.value : savedValue;
                    
                    config[key] = {
                        type: "BYPASSER", name: bypasserName ? bypasserName : `Bypasser ${inIdx}`,
                        match_group: groupName ? [groupName] : null, match_id: matchIds.length > 0 ? matchIds : null,
                        default: true, value: activeValue, _slot: 100 + inIdx 
                    };
                    validKeys.push(key);
                });

                if (jsonW) {
                    jsonW.value = JSON.stringify(config);
                    // 🌟 核心修复：同步更新 widgets_values 数组，确保存盘/序列化时写进磁盘 JSON 文件！
                    if (this.widgets_values && Array.isArray(this.widgets_values)) {
                        const idx = this.widgets.indexOf(jsonW);
                        if (idx !== -1) this.widgets_values[idx] = jsonW.value;
                    }
                }

                const hasActiveSeed = Object.values(config).some(p => p.type === "SEED");
                const hasActiveUploader = Object.values(config).some(p => p.type === "UPLOADER");
                let seenControlAfterGenerate = false; 
                
                for (let i = this.widgets.length - 1; i >= 0; i--) {
                    const w = this.widgets[i];
                    if (w.value === "Upload" && !w.associatedKey) { this.widgets.splice(i, 1); continue; }
                    
                    if (w.name === "control_after_generate") {
                        if (!hasActiveSeed) { this.widgets.splice(i, 1); continue; } 
                        else {
                            if (seenControlAfterGenerate) { this.widgets.splice(i, 1); continue; } 
                            else { seenControlAfterGenerate = true; }
                        }
                    }
                    
                    if (w.value === "Upload" && w.associatedKey) {
                        if (!validKeys.includes(w.associatedKey) || !hasActiveUploader) { this.widgets.splice(i, 1); continue; }
                    }
                    
                    const isProtected = [
                        "config_json", "control_after_generate", "btn_app_view", 
                        "converted-widget", "hidden_parameter", "Auto Launch", "Short Title"
                    ].includes(w.name) || w.type === "hidden_parameter" || w.is_appview_button || 
                    (w.value === "Upload" && w.associatedKey && validKeys.includes(w.associatedKey)); 
                    
                    if (!isProtected && !validKeys.includes(w.name)) { this.widgets.splice(i, 1); }
                }

                Object.entries(config).forEach(([key, param]) => {
                    let defaultVal = param.value !== undefined ? param.value : param.default;
                    if (defaultVal === null || defaultVal === undefined) {
                        if (param.type === "COMBO" || param.type === "UPLOADER") { defaultVal = param.values ? param.values[0] : "None"; } 
                        else if (param.type === "INT" || param.type === "FLOAT" || param.type === "SEED") { defaultVal = 0; } 
                        else if (param.type === "BOOLEAN") { defaultVal = true; } 
                        else { defaultVal = ""; }
                    }
                    
                    let existingW = this.widgets.find(w => w.name === key);
                    if (existingW) {
                        let currentWType = String(existingW.type).toUpperCase();
                        let targetWType = String(param.type).toUpperCase();
                        if (targetWType === "FLOAT" || targetWType === "INT" || targetWType === "SEED") targetWType = "NUMBER";
                        if (targetWType === "BOOLEAN") targetWType = "TOGGLE";
                        if (targetWType === "STRING" || targetWType === "LORA_STACK") targetWType = "TEXT";
                        if (targetWType === "UPLOADER") targetWType = "COMBO";
                        
                        if (currentWType !== targetWType && !(currentWType === "CONVERTED-WIDGET" && targetWType === "NUMBER")) {
                            const wIdx = this.widgets.indexOf(existingW);
                            if (wIdx !== -1) {
                                if (existingW.onRemove) existingW.onRemove();
                                this.widgets.splice(wIdx, 1); existingW = null; 
                            }
                        }
                    }
                    if (param.type === "UPLOADER") {
                        existingW = setupUploaderWidget(this, key, param, defaultVal, validKeys);
                        if (existingW) {
                            const origCallback = existingW.callback;
                            existingW.callback = (v) => { saveWidgetValueToConfig(this, key, v); if (origCallback) origCallback(v); };
                        }
                    } else if (!existingW) {
                        if (param.type === "BYPASSER") {
                            existingW = this.addWidget("toggle", key, true, (v) => {
                                const currentJsonW = this.widgets?.find(w => w.name === "config_json");
                                if (currentJsonW && currentJsonW.value) {
                                    try {
                                        const currentConfig = JSON.parse(currentJsonW.value);
                                        const currentParam = currentConfig[key];
                                        if (currentParam) { applyBypasser(v, currentParam, app.graph); }
                                    } catch(e) {}
                                }
                                saveWidgetValueToConfig(this, key, v); 
                            }, {});
                            setTimeout(() => { if (existingW) applyBypasser(existingW.value, param, app.graph); }, 100);
                        } else if (param.type === "SEED") {
                            existingW = ComfyWidgets.INT(this, key, ["INT", { 
                                default: defaultVal, min: param.min ?? 0, max: param.max ?? 0xffffffffffffffff, control_after_generate: true 
                            }], app).widget;
                            if (existingW) existingW.callback = (v) => saveWidgetValueToConfig(this, key, v);
                            const companionW = this.widgets.find(w => w.name === "control_after_generate");
                            if (companionW) {
                                if (param.seed_mode) companionW.value = param.seed_mode;
                                companionW.callback = (v) => {
                                    saveWidgetValueToConfig(this, key, existingW ? existingW.value : defaultVal);
                                    // 实时将 seed_mode 保存到 config_json
                                    const currentJsonW = this.widgets?.find(w => w.name === "config_json");
                                    if (currentJsonW && currentJsonW.value) {
                                        try {
                                            const currentCfg = JSON.parse(currentJsonW.value);
                                            if (currentCfg[key]) { 
                                                currentCfg[key].seed_mode = v; 
                                                currentJsonW.value = JSON.stringify(currentCfg); 
                                            }
                                        } catch(e) {}
                                    }
                                };
                            }
                        } else if (param.type === "COMBO") {
                            existingW = this.addWidget("combo", key, defaultVal, ()=>{}, {values: param.values});
                        } else if (param.type === "INT" || param.type === "FLOAT") {
                            const isInt = param.type === "INT";
                            const step = param.step ?? (isInt ? 1 : 0.1);
                            const prec = param.precision ?? (isInt ? 0 : 3);
                            const isSlider = param.display === "slider" || param.slider === true;
                            const hasBounds = param.min !== undefined && param.max !== undefined;
                            const useSlider = isSlider && hasBounds;
                            const minVal = param.min ?? -999999; const maxVal = param.max ?? 999999;
                            const widgetStep = useSlider ? step : step * 10;
                            
                            existingW = this.addWidget(useSlider ? "slider" : "number", key, defaultVal, (v)=>{
                                saveWidgetValueToConfig(this, key, v);
                            }, { min: minVal, max: maxVal, step: widgetStep, precision: prec });
                        } else if (param.type === "BOOLEAN") {
                            existingW = this.addWidget("toggle", key, Boolean(defaultVal ?? true), (v) => {
                                saveWidgetValueToConfig(this, key, v);
                            }, {});
                        } else if (param.type === "LORA_STACK") {
                            existingW = this.addWidget("text", key, defaultVal || "[]", (v) => saveWidgetValueToConfig(this, key, v), { read_only: true });
                            if (existingW) {
                                existingW.disabled = true;
                                existingW.options = existingW.options || {};
                                existingW.options.read_only = true;
                                existingW.label = `🔒 ${param.name || key}`;
                            }
                        } else if (param.type === "STRING" && param.multiline) {
                            existingW = ComfyWidgets.STRING(this, key, ["STRING", { multiline: true, default: defaultVal || "" }], app).widget;
                            if (existingW) existingW.callback = (v) => saveWidgetValueToConfig(this, key, v);
                            if (existingW.inputEl) {
                                if (existingW.inputEl) existingW.inputEl.placeholder = param.name;
                                existingW.inputEl.addEventListener("input", (e) => { saveWidgetValueToConfig(this, key, e.target.value); });
                            }
                        } else {
                            existingW = this.addWidget("text", key, defaultVal, (v) => saveWidgetValueToConfig(this, key, v), {});
                        }
                        const label = param.name || key;
                        existingW.label = (param.type === "LORA_STACK") ? `🔒 ${label}` : label;
                    } else {
                        const label = param.name || key;
                        existingW.label = (param.type === "LORA_STACK") ? `🔒 ${label}` : label;
                        existingW.callback = (v) => saveWidgetValueToConfig(this, key, v);
                    }
                });
                
                const staticWidgets = this.widgets.filter(w => 
                    w.name === "config_json" || w.name === "converted-widget" || w.type === "hidden_parameter" || w.is_appview_button || w.name === "Auto Launch" || w.name === "Short Title"
                );
                const sortedDynamicWidgets = [];
                Object.keys(config).forEach(key => {
                    const w = this.widgets.find(wd => wd.name === key);
                    if (w) {
                        sortedDynamicWidgets.push(w);
                        if (config[key].type === "SEED") {
                            const companion = this.widgets.find(c => c.name === "control_after_generate");
                            if (companion) sortedDynamicWidgets.push(companion);
                        }
                        if (config[key].type === "UPLOADER") {
                            const uploadBtn = this.widgets.find(u => u.value === "Upload" && u.associatedKey === key);
                            if (uploadBtn) sortedDynamicWidgets.push(uploadBtn);
                        }
                    }
                });
                const remainingWidgets = this.widgets.filter(w => !staticWidgets.includes(w) && !sortedDynamicWidgets.includes(w));
                this.widgets = [...staticWidgets, ...sortedDynamicWidgets, ...remainingWidgets];
                if (this.widgets_values && Array.isArray(this.widgets_values)) {
                    this.widgets.forEach((w, idx) => {
                        if (this.widgets_values[idx] !== undefined && this.widgets_values[idx] !== null) {
                            w.value = this.widgets_values[idx];
                        }
                    });
                }
                this.setDirtyCanvas(true, true);
            };
        }
    }
});