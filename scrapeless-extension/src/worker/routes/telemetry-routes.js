/**
 * registerLoggingHandlers registration.
 * Extracted from message-router switch cases for maintainability.
 */
function registerLoggingRoutes(localRegistry, localContext) {
    void localContext;

    const route_debug_trace = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        // Route content/main-world logs to service worker console
        if (inbound.context && inbound.level && inbound.args) {
            const levelIndex = {
                warn: Telemetry.OWNED_LEVELS.WARN,
                error: Telemetry.OWNED_LEVELS.ERROR,
                debug: Telemetry.OWNED_LEVELS.DEBUG,
                info: Telemetry.OWNED_LEVELS.INFO,
                log: Telemetry.OWNED_LEVELS.INFO
            };

            const localMappedLevel = levelIndex[inbound.level] || Telemetry.OWNED_LEVELS.INFO;
            const localSafeArgs = Array.isArray(inbound.args) ? inbound.args.slice(0, 5).map((operand) => Telemetry.performSanitize(operand)) : [];

            Telemetry.performOutputToConsole({
                timestamp: new Date(inbound.timestamp || Date.now()).toISOString(),
                context: inbound.context,
                category: Telemetry.TAXONOMIES.BACKGROUND,
                level: localMappedLevel,
                message: localSafeArgs.join(' '),
                data: null
            });
        }
    };
    localRegistry['DIAGNOSTIC_RECORD'] = route_debug_trace;

    const route_trace = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        if (inbound.log) {
            Telemetry.performOutputToConsole(inbound.log);
        }
    };
    localRegistry['RECORD'] = route_trace;

    const route_bridge_debug_trace = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        // Forward debug logs from content scripts (gated by debug mode)
        (async () => {
            try {
                const preferencePane = await ExtensionGateway.resolvePreferences(chrome);
                const traceCollectorRunning = typeof traceCollector !== 'undefined' && traceCollector.enabled;
                if (preferencePane?.diagnosticMode) {
                    if (traceCollectorRunning && inbound.level === 'log') {
                        return;
                    }
                    const localTimestamp = new Date(inbound.timestamp).toISOString().split('T')[1].slice(0, -1);
                    const localPrefix = `[${localTimestamp}] [${inbound.source || 'hooks'}]`;
                    switch (inbound.level) {
                        case 'log': Telemetry.performBackground(localPrefix, inbound.message); break;
                        case 'warn': Telemetry.performWarn('BACKGROUND', localPrefix, inbound.message); break;
                        case 'error': Telemetry.failure('BACKGROUND', localPrefix, inbound.message); break;
                        default: Telemetry.performBackground(localPrefix, inbound.message);
                    }
                }
            } catch (failure) {
                Telemetry.performWarn('BACKGROUND', '[SCRAPELESS_DEBUG_LOG] Could not read settings for debug log:', failure);
            }
        })();
    };
    localRegistry['SCRAPELESS_DEBUG_LOG'] = route_bridge_debug_trace;

    const route_probe_failure_report = function({ request: inbound, sender: localSender, sendResponse: sendReply, context: localContext }) {
        void localContext;

        // Hook diagnostics from MAIN world (debug mode only)
        (async () => {
            try {
                const preferencePane = await ExtensionGateway.resolvePreferences(chrome);
                if (!preferencePane?.diagnosticMode) return;
                Telemetry.performWarn('HOOKS', `[Hooks] ${inbound.type}`, {
                    target: inbound.target,
                    failureType: inbound.failureType,
                    message: inbound.message,
                    success: inbound.success,
                    error: inbound.error
                });
            } catch (failure) {
                Telemetry.performWarn('HOOKS', '[PROBE_FAILURE_REPORT] Could not read settings for hook diagnostic:', failure);
            }
        })();
        sendReply({ status: 'ignored' });
    };
    localRegistry['PROBE_FAILURE_REPORT'] = route_probe_failure_report;
    localRegistry['PROBE_TAMPERING_DETECTED'] = route_probe_failure_report;
    localRegistry['PROBE_RECOVERY_RESULT'] = route_probe_failure_report;

}
