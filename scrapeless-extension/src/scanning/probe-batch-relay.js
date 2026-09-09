// Main-world hook message handling and batching for DetectionEngineManager.

function composeAdaptiveProbeBatcher(localChrome) {
    // Adaptive batching; adjusts window based on detection frequency
    let probeBatch = [];
    let probeBatchDeadline = null;
    let lastBatchCapacity = 0;
    let lastBatchMoment = Date.now();
    const PROBE_BATCH_DELAY_FLOOR = 10;  // 10ms when many hooks firing (busy)
    const PROBE_BATCH_DELAY_LIMIT = 50;  // 50ms when few hooks (idle)
    const PROBE_BATCH_LIMIT_CAPACITY = 20;   // Force flush at 20 hooks
    const PROBE_BATCH_EMERGENCY_CAPACITY = 50; // Drop oldest if exceeds 50 (safety guard)

    function resolveAdaptiveBatchDelay() {
        const momentSinceLastBatch = Date.now() - lastBatchMoment;

        // If hooks firing rapidly (< 100ms between batches), use shorter delay
        if (momentSinceLastBatch < 100 && lastBatchCapacity > 5) {
            return PROBE_BATCH_DELAY_FLOOR;
        }

        // If hooks firing slowly, use longer delay to batch more
        if (momentSinceLastBatch > 500) {
            return PROBE_BATCH_DELAY_LIMIT;
        }

        // Interpolate between min and max based on batch size
        const capacityRatio = Math.min(lastBatchCapacity / 10, 1);
        return PROBE_BATCH_DELAY_FLOOR + (PROBE_BATCH_DELAY_LIMIT - PROBE_BATCH_DELAY_FLOOR) * (1 - capacityRatio);
    }

    function flushProbeBatch() {
        if (probeBatch.length === 0) return;

        // Flush on overflow to prevent memory leak
        if (probeBatch.length > PROBE_BATCH_EMERGENCY_CAPACITY) {
            Telemetry.performWarn('HOOKS', `Hook batch overflow (${probeBatch.length} hooks), forcing immediate flush`);
            // Prevents double flush
            if (probeBatchDeadline) {
                clearTimeout(probeBatchDeadline);
                probeBatchDeadline = null;
            }
        }

        if (!localChrome.runtime?.id) {
            Telemetry.failure('CONTENT', '[Content Script] Extension context invalidated, cannot forward hooks');
            probeBatch = [];
            return;
        }

        // Deduplicate by detector:hook combination (one detection per detectorId:target)
        const uniqueProbes = new Map();
        for (const probePayload of probeBatch) {
            const lookupKey = `${probePayload.detection.detectorId}:${probePayload.detection.hook.target}`;
            if (!uniqueProbes.has(lookupKey)) {
                uniqueProbes.set(lookupKey, probePayload);
            }
        }

        const deduplicatedProbes = Array.from(uniqueProbes.values());

        // Send batched detections (try-catch for context errors)
        try {
            localChrome.runtime.sendMessage({
                type: 'PROBE_SIGNAL_BATCH',
                detections: deduplicatedProbes,
                timestamp: Date.now()
            }).catch((failure) => {
                const failureMsg = failure?.message || '';

                // Expected on extension reload
                if (failureMsg.includes('Could not establish connection') ||
                    failureMsg.includes('Receiving end does not exist')) {
                }
                else if (failureMsg.includes('Extension context invalidated')) {
                }
                else {
                    Telemetry.performDebug('CONTENT', '[hookBatcher] Failed to send hook batch:', failure);
                }
            });
        } catch (failure) {
            // Expected: context invalidated
        }

        lastBatchCapacity = probeBatch.length;
        lastBatchMoment = Date.now();

        probeBatch = [];
        probeBatchDeadline = null;
    }

    return {
        addHook: function(probePayload) {
            probeBatch.push(probePayload);

            // Force flush if oversized
            if (probeBatch.length >= PROBE_BATCH_LIMIT_CAPACITY) {
                if (probeBatchDeadline) {
                    clearTimeout(probeBatchDeadline);
                    probeBatchDeadline = null;
                }
                flushProbeBatch();
            }
            // Schedule flush (adaptive delay)
            else if (!probeBatchDeadline) {
                const localDelay = resolveAdaptiveBatchDelay();
                probeBatchDeadline = setTimeout(flushProbeBatch, localDelay);
            }
        },
        flush: flushProbeBatch,
        getTimeout: function() {
            return probeBatchDeadline;
        },
        clearTimeout: function() {
            if (probeBatchDeadline) {
                clearTimeout(probeBatchDeadline);
                probeBatchDeadline = null;
            }
        }
    };
}


function routeProbeBridgePacket(signal, localChrome, probeBatch) {
    // Only accept messages from same origin
    if (signal.source !== window) return false;

    const payload = signal.data;

    // Forward logs from MAIN world to service worker via debug system
    if (payload && payload.type === 'PAGE_AGENT_RECORD') {
        if (localChrome.runtime?.id) {
            localChrome.runtime.sendMessage({
                type: 'DIAGNOSTIC_RECORD',
                context: 'MAIN_WORLD',
                level: payload.level,
                args: payload.args,
                timestamp: payload.timestamp
            }).catch((failure) => {
                // Expected: Background may not be ready
                Telemetry.probes('[MAIN_WORLD] Failed to forward log to background:', failure.message);
            });
        }
        return true;
    }

    if (payload && payload.type === 'PROBE_SIGNAL') {
        // Defensive check
        if (window.__scrapelessCacheHitEarlyExit) {
            Telemetry.performDebug('CONTENT', '[handleHookBridgeMessage] Hook detection received despite cache hit, ignoring');
            return true;
        }

        probeBatch.addHook({
            detection: payload.detection,
            url: payload.url,
            timestamp: payload.detection?.timestamp || Date.now()
        });
        return true;
    }

    if (payload && payload.type === 'GLOBAL_SIGNALS') {
        // Defensive check
        if (window.__scrapelessCacheHitEarlyExit) {
            Telemetry.performDebug('CONTENT', '[handleHookBridgeMessage] Window detections received despite cache hit, ignoring');
            return true;
        }

        const findings = payload.detections || [];
        Telemetry.findingsPane(`[Content Script] Window detections received: ${findings.length} properties detected in ${payload.elapsedMs || 0}ms`);

        if (!localChrome.runtime?.id) {
            Telemetry.failure('CONTENT', '[Content Script] Extension context invalidated, cannot send window detections');
            return true;
        }

        localChrome.runtime.sendMessage({
            type: 'GLOBAL_SIGNALS',
            detections: findings,
            timestamp: payload.timestamp,
            executionTime: payload.elapsedMs
        }).then(() => {
            Telemetry.findingsPane(`[Content Script] Window detections forwarded to background`);
        }).catch((failure) => {
            Telemetry.failure('CONTENT', '[Content Script] Failed to send window detections:', failure);
        });
        return true;
    }

    if (payload && payload.type === 'GLOBAL_SIGNALS_COMPLETE') {
        (async () => {
            const localSendCompletion = async () => {
                const LIMIT_ATTEMPTS = 3;
                for (let localAttempt = 1; localAttempt <= LIMIT_ATTEMPTS; localAttempt++) {
                    if (!localChrome.runtime?.id) {
                        Telemetry.failure('DETECTION', `[Content Script] Extension context invalidated (attempt ${localAttempt}) - window props completion not sent`);
                        await new Promise(localResolve => setTimeout(localResolve, localAttempt * 100));
                        continue;
                    }

                    try {
                        await localChrome.runtime.sendMessage({
                            type: 'GLOBAL_SIGNALS_COMPLETE',
                            url: payload.url,
                            timestamp: payload.timestamp,
                            detectedCount: payload.detectedCount
                        });
                        Telemetry.findingsPane(`[Content Script] Window properties completion signal sent successfully on attempt ${localAttempt}`);
                        return;
                    } catch (failure) {
                        Telemetry.failure('DETECTION', `[Content Script] Failed to send window props completion signal (attempt ${localAttempt}):`, failure);
                        await new Promise(localResolve => setTimeout(localResolve, localAttempt * 100));
                    }
                }

                Telemetry.failure('CONTENT', '[Content Script] Giving up on window props completion signal after repeated failures');
            };

            await localSendCompletion();
        })();
        return true;
    }

    if (payload && payload.type === 'PROBE_HOOKS_COMPLETE') {
        // Flush pending hooks before sending completion to prevent race condition
        (async () => {
            if (probeBatch.getTimeout()) {
                probeBatch.clearTimeout();
                probeBatch.flush();
                await new Promise(localResolve => setTimeout(localResolve, 50));
            }

            const localSendCompletion = async () => {
                const LIMIT_ATTEMPTS = 3;
                for (let localAttempt = 1; localAttempt <= LIMIT_ATTEMPTS; localAttempt++) {
                    if (!localChrome.runtime?.id) {
                        Telemetry.failure('DETECTION', `[Content Script] Extension context invalidated (attempt ${localAttempt}) - completion not sent`);
                        await new Promise(localResolve => setTimeout(localResolve, localAttempt * 100));
                        continue;
                    }

                    try {
                        await localChrome.runtime.sendMessage({
                            type: 'PROBE_HOOKS_COMPLETE',
                            url: payload.url,
                            timestamp: payload.timestamp,
                            totalDetections: payload.totalDetections,
                            uniqueHooks: payload.uniqueHooks,
                            completionReason: payload.completionReason,
                            completionTime: payload.completionTime,
                            uninstallStats: payload.uninstallStats
                        });
                        Telemetry.findingsPane(`[Content Script] Completion signal sent successfully on attempt ${localAttempt}`);
                        return;
                    } catch (failure) {
                        Telemetry.failure('DETECTION', `[Content Script] Failed to send completion signal (attempt ${localAttempt}):`, failure);
                        await new Promise(localResolve => setTimeout(localResolve, localAttempt * 100));
                    }
                }

                Telemetry.failure('CONTENT', '[Content Script] Giving up on completion signal after repeated failures');
            };

            await localSendCompletion();
        })();
        return true;
    }

    return false;
}
