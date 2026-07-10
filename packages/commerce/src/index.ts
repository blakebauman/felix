/**
 * @felix/commerce — package entry. The orchestrator consumes exactly one
 * symbol: the FelixPlugin that bundles every commerce contribution (routes,
 * tools, cron tasks, middleware knobs). Internals stay reachable via the
 * `@felix/commerce/<path>` subpath exports (used by tests), but the plugin
 * object is the supported surface.
 */

export { commercePlugin } from './plugin';
