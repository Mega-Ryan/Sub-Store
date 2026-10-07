import { AsyncLocalStorage } from 'node:async_hooks';

// Upstream parser/output helpers expect $.info/error. They must never import
// OpenAPI, persist state, or log subscription URLs and node credentials.
const logs = new AsyncLocalStorage();
const parserWarning =
    '部分输入节点无法解析或不能输出到所选客户端，请检查节点预览。';
const warn = () => {
    const warnings = logs.getStore();
    if (warnings && !warnings.includes(parserWarning)) warnings.push(parserWarning);
};
const noop = () => {};

export function withConversionWarnings(warnings, operation) {
    return logs.run(warnings, operation);
}

export default Object.freeze({
    env: Object.freeze({
        isNode: false,
        isWorkers: true,
        isLoon: false,
        isSurge: false,
        isQX: false,
    }),
    log: noop,
    info: noop,
    warn,
    error: warn,
});
