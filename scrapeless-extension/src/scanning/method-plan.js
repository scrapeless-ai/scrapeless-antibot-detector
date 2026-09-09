// Detection analysis helpers for DetectionEngineManager.

function analyzeConfiguredScanPhases() {
    const localNow = Date.now();
    if (this.methodPlanCache && (localNow - this.analyzedMethodsCacheTime) < this.ANALYSIS_CACHE_TTL) {
        return this.methodPlanCache;
    }

    const usedPhases = {
        cookie: false,
        header: false,
        content: false,
        dom: false,
        url: false,
        window: false,
        js_hooks: false,
        payload: false
    };

    usedPhases.url = true;

    if (!this.ruleSet) {
        Telemetry.performWarn('DETECTION', '[C.1] No detectors loaded, will collect all data types');
        const fullPhases = {
            cookie: true, header: true, content: true, dom: true,
            url: true, window: true, js_hooks: true, payload: true
        };
        this.methodPlanCache = fullPhases;
        this.analyzedMethodsCacheTime = localNow;
        return fullPhases;
    }

    for (const [taxonomy, taxonomyCatalog] of Object.entries(this.ruleSet)) {
        for (const [ruleToken, rule] of Object.entries(taxonomyCatalog)) {
            const findingsPane = rule.detection || {};

            if (findingsPane.cookie && findingsPane.cookie.length > 0) usedPhases.cookie = true;
            if (findingsPane.header && findingsPane.header.length > 0) usedPhases.header = true;
            if (findingsPane.performContent && findingsPane.performContent.length > 0) usedPhases.content = true;
            if (findingsPane.dom && findingsPane.dom.length > 0) usedPhases.dom = true;
            if (findingsPane.url && findingsPane.url.length > 0) usedPhases.url = true;
            if (findingsPane.window && findingsPane.window.length > 0) usedPhases.window = true;
            if (findingsPane.js_hooks && findingsPane.js_hooks.length > 0) usedPhases.js_hooks = true;
            if (findingsPane.payload && findingsPane.payload.length > 0) usedPhases.payload = true;
        }
    }

    this.methodPlanCache = usedPhases;
    this.analyzedMethodsCacheTime = localNow;

    Telemetry.findingsPane('[C.1] Detection methods analysis:', usedPhases);
    return usedPhases;
}


function localRequiresExternalScriptContent() {
    if (!this.ruleSet) return false;

    for (const taxonomyCatalog of Object.values(this.ruleSet)) {
        for (const rule of Object.values(taxonomyCatalog)) {
            if (rule.enabled === false) continue;

            const contentMatchers = rule.detection?.content;
            if (contentMatchers && Array.isArray(contentMatchers)) {
                for (const matcher of contentMatchers) {
                    if (matcher.checkScripts === true || !matcher.checkScripts) {
                        return true;
                    }
                }
            }
        }
    }

    return false;
}


function measureRulePriorities() {
    if (!this.ruleSet) {
        this.executionPlan = [];
        return;
    }

    const localPriorities = [];

    for (const [taxonomy, taxonomyCatalog] of Object.entries(this.ruleSet)) {
        for (const [ruleLabel, rule] of Object.entries(taxonomyCatalog)) {
            // Skip disabled detectors
            if (rule.enabled === false) continue;

            // Priority: 3=fast (cookie/url/header), 2=medium (content), 1=slow (DOM)
            let localPriority = 0;
            const findingsPane = rule.detection || {};

            if (findingsPane.cookie?.length > 0) localPriority = Math.max(localPriority, 3);
            if (findingsPane.url?.length > 0) localPriority = Math.max(localPriority, 3);
            if (findingsPane.header?.length > 0) localPriority = Math.max(localPriority, 3);
            if (findingsPane.performContent?.length > 0) localPriority = Math.max(localPriority, 2);
            if (findingsPane.dom?.length > 0) localPriority = Math.max(localPriority, 1);

            localPriorities.push({
                category: taxonomy,
                detectorName: ruleLabel,
                detector: rule,
                priority: localPriority
            });
        }
    }

    localPriorities.sort((leftValue, rightValue) => rightValue.priority - leftValue.priority);
    this.executionPlan = localPriorities;

    Telemetry.findingsPane(`[Phase 1 Optimization] Pre-computed priorities for ${localPriorities.length} detectors`);
}
