import { parse, produce } from './core.js';
import { PROCESSORS } from './processors.js';
import PRODUCERS from '@/core/proxy-utils/producers';
import { withConversionWarnings } from './app.js';
import {
    ConversionError,
    validateProcessors,
    validateNodes,
    unsupported,
} from './validation.js';

export { ConversionError, validateProcessors, SUPPORTED_PROCESSORS } from './validation.js';

export const SUPPORTED_TARGETS = Object.freeze(Object.keys(PRODUCERS));
export function validateTarget(target) {
    if (typeof target !== 'string' || !Object.prototype.hasOwnProperty.call(PRODUCERS, target)) {
        throw new ConversionError('UNSUPPORTED_TARGET', '当前基础版不支持目标格式：' + target, 'target');
    }
    return target;
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROXIES = 10000;
const OUTPUT_OPTIONS = new Set([
    'include-unsupported-proxy', 'delete-underscore-fields', 'prettyYaml', 'pretty-yaml',
]);

function producerOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new ConversionError('INVALID_ARGUMENT', '输出选项必须是对象', 'options');
    }
    for (const key of Object.keys(options)) {
        if (!OUTPUT_OPTIONS.has(key)) unsupported('当前基础版不支持输出选项：' + key, 'options.' + key);
        if (typeof options[key] !== 'boolean') {
            throw new ConversionError('INVALID_ARGUMENT', '输出选项必须是布尔值', 'options.' + key);
        }
    }
    return options;
}

async function apply(proxies, items) {
    let output = clone(proxies);
    for (const item of items) {
        if (item.disabled) continue;
        const args = item.args ?? (item.type === 'Sort Operator' ? 'asc' : {});
        try {
            const processor = PROCESSORS[item.type](args);
            if (item.type.endsWith('Filter')) {
                const selection = await processor.func(output);
                output = output.filter((_, index) => selection[index]);
            } else {
                const next = await processor.func(clone(output));
                if (!Array.isArray(next)) throw new Error('处理动作未返回节点数组');
                output = next;
            }
        } catch (error) {
            throw new ConversionError(
                'PROCESSOR_FAILED',
                '处理动作执行失败：' + item.type + '；' + error.message,
                'process',
            );
        }
    }
    return output;
}

/**
 * Convert already downloaded sources without performing I/O or touching storage.
 * Sources: a string, or [{ content, processors?, name?, displayName?, description? }].
 * Per-source processors run before the final collection-level processors.
 * context.options contains only allowed producer options; context.type can be
 * 'internal' for structured producer output. Return full before/after previews.
 */
export async function convert(rawSources, target = 'ClashMeta', processors = [], context = {}) {
    validateTarget(target);
    const sources = Array.isArray(rawSources) ? rawSources : [rawSources];
    if (sources.length > 32) {
        throw new ConversionError('LIMIT_EXCEEDED', '单次转换最多支持 32 个订阅源', 'sources', 413);
    }
    validateProcessors(processors);
    const normalized = sources.map((source, index) => {
        const item = typeof source === 'string' ? { content: source } : source;
        if (!item || typeof item.content !== 'string') {
            throw new ConversionError('INVALID_ARGUMENT', '订阅内容必须是字符串', 'sources[' + index + '].content');
        }
        validateProcessors(item.processors ?? [], 'sources[' + index + '].process');
        return item;
    });
    const bytes = normalized.reduce((total, source) => total + new TextEncoder().encode(source.content).byteLength, 0);
    if (bytes > MAX_INPUT_BYTES) {
        throw new ConversionError('LIMIT_EXCEEDED', '单次转换输入不能超过 2 MiB', 'sources', 413);
    }
    const options = producerOptions(context.options ?? {});
    if (context.type != null && !['internal', 'text'].includes(context.type)) {
        throw new ConversionError('INVALID_ARGUMENT', '输出类型无效', 'type');
    }
    const warnings = [];
    return withConversionWarnings(warnings, async () => {
        const originalProxies = [];
        let proxies = [];
        for (const source of normalized) {
            const parsed = parse(source.content);
            validateNodes(parsed);
            for (const proxy of parsed) {
                if (source.name) proxy._subName = source.displayName || source.name;
                if (source.description) proxy._desc = source.description;
            }
            originalProxies.push(...clone(parsed));
            if (originalProxies.length > MAX_PROXIES) {
                throw new ConversionError('LIMIT_EXCEEDED', '单次转换最多支持 10000 个节点', 'proxies', 413);
            }
            proxies.push(...await apply(parsed, source.processors ?? []));
        }
        proxies = await apply(proxies, processors);
        validateNodes(proxies);
        let output;
        try {
            output = produce(clone(proxies), target, context.type === 'internal' ? 'internal' : undefined, options);
        } catch {
            throw new ConversionError('CONVERSION_FAILED', '目标格式无法生成：' + target, 'target');
        }
        return { originalProxies, proxies, output, target, warnings };
    });
}
