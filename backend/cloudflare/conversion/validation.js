import { PROCESSORS } from './processors.js';

export const SUPPORTED_PROCESSORS = Object.freeze(Object.keys(PROCESSORS));
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

export class ConversionError extends Error {
    constructor(code, message, path = 'conversion', status = 400) {
        super(message);
        this.name = 'ConversionError';
        this.code = code;
        this.status = status;
        this.details = [{ path, message }];
    }
}

function invalid(message, path) {
    throw new ConversionError('INVALID_ARGUMENT', message, path);
}

export function unsupported(message, path) {
    throw new ConversionError('UNSUPPORTED_FEATURE', message, path, 422);
}

function objectKeys(value, allowed, path) {
    if (!plain(value)) invalid('参数必须是对象', path);
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key) || forbiddenKeys.has(key)) {
            unsupported('当前基础版不支持参数：' + key, path + '.' + key);
        }
    }
}

function string(value, path, maximum = 512) {
    if (typeof value !== 'string' || value.length > maximum) {
        invalid('参数必须是长度不超过 ' + maximum + ' 的字符串', path);
    }
}

function strings(value, path, maximum = 128) {
    if (!Array.isArray(value) || value.length > maximum) {
        invalid('参数必须是长度不超过 ' + maximum + ' 的数组', path);
    }
    value.forEach((item, index) => string(item, path + '[' + index + ']'));
}

function regex(value, path) {
    string(value, path, 1024);
    try {
        new RegExp(value.startsWith('(?i)') ? value.slice(4) : value);
    } catch {
        invalid('正则表达式无效', path);
    }
}

function regularExpressions(value, path) {
    if (!Array.isArray(value) || value.length > 128) {
        invalid('正则表达式必须是长度不超过 128 的数组', path);
    }
    value.forEach((value, index) => regex(value, path + '[' + index + ']'));
}

function condition(rule, path, depth = 0, counter = { count: 0 }) {
    if (depth > 8 || ++counter.count > 64) invalid('条件规则过于复杂', path);
    if (!plain(rule)) invalid('条件规则必须是对象', path);
    if (own(rule, 'operator')) {
        objectKeys(rule, ['operator', 'child'], path);
        if (rule.operator === 'NOT') {
            condition(rule.child, path + '.child', depth + 1, counter);
        } else if (['AND', 'OR'].includes(rule.operator)) {
            if (!Array.isArray(rule.child) || rule.child.length > 32) {
                invalid('AND／OR 子条件必须是数组', path + '.child');
            }
            rule.child.forEach((child, i) =>
                condition(child, path + '.child[' + i + ']', depth + 1, counter),
            );
        } else invalid('未知条件逻辑运算', path + '.operator');
        return;
    }
    objectKeys(rule, ['attr', 'proposition', 'value'], path);
    string(rule.attr, path + '.attr');
    if (forbiddenKeys.has(rule.attr)) invalid('条件属性无效', path + '.attr');
    if (!['IN', 'CONTAINS', 'EQUALS', 'EXISTS'].includes(rule.proposition)) {
        invalid('未知条件比较运算', path + '.proposition');
    }
    if (rule.proposition === 'IN') {
        if (!Array.isArray(rule.value) || rule.value.length > 128) {
            invalid('IN 比较值必须是数组', path + '.value');
        }
    } else if (rule.proposition === 'CONTAINS') {
        string(rule.value, path + '.value');
    }
}

function validateArgs(type, args, path) {
    switch (type) {
        case 'Useless Filter':
            objectKeys(args, [], path);
            break;
        case 'Region Filter':
        case 'Type Filter': {
            const values = Array.isArray(args) ? args : args.value;
            if (!Array.isArray(args)) {
                objectKeys(args, ['value', 'keep'], path);
                if (args.keep != null && typeof args.keep !== 'boolean') {
                    invalid('keep 必须是布尔值', path + '.keep');
                }
            }
            strings(values, path + '.value');
            break;
        }
        case 'Regex Filter':
            objectKeys(args, ['regex', 'keep'], path);
            regularExpressions(args.regex ?? [], path + '.regex');
            if (args.keep != null && typeof args.keep !== 'boolean') {
                invalid('keep 必须是布尔值', path + '.keep');
            }
            break;
        case 'Conditional Filter':
            objectKeys(args, ['rule'], path);
            condition(args.rule, path + '.rule');
            break;
        case 'Quick Setting Operator':
            objectKeys(args, [
                'useless', 'udp', 'tfo', 'scert', 'vmess aead', 'reuse', 'ecn',
                'block-quic', 'ip-version',
            ], path);
            for (const [key, value] of Object.entries(args)) {
                const allowed = key === 'block-quic'
                    ? ['DEFAULT', 'auto', 'on', 'off', '', null]
                    : key === 'ip-version'
                      ? ['DEFAULT', 'dual', 'v4-only', 'v6-only', 'prefer-v4', 'prefer-v6', '', null]
                      : ['DEFAULT', 'ENABLED', 'DISABLED', '', null];
                if (!allowed.includes(value)) invalid('快捷设置值无效', path + '.' + key);
            }
            break;
        case 'Flag Operator':
            objectKeys(args, ['mode', 'tw'], path);
            if (args.mode != null && !['add', 'remove'].includes(args.mode)) {
                invalid('旗帜处理模式无效', path + '.mode');
            }
            if (args.tw != null && !['cn', 'tw', 'ws'].includes(args.tw)) {
                invalid('台湾旗帜选项无效', path + '.tw');
            }
            break;
        case 'Sort Operator':
            if (!['asc', 'desc', 'random'].includes(args)) invalid('排序选项无效', path);
            break;
        case 'Regex Sort Operator':
            if (Array.isArray(args)) regularExpressions(args, path);
            else {
                objectKeys(args, ['order', 'expressions'], path);
                regularExpressions(args.expressions ?? [], path + '.expressions');
                if (args.order != null && !['asc', 'desc', 'original'].includes(args.order)) {
                    invalid('正则排序选项无效', path + '.order');
                }
            }
            break;
        case 'Regex Rename Operator':
            if (!Array.isArray(args) || args.length > 128) invalid('重命名规则必须是数组', path);
            args.forEach((item, i) => {
                const itemPath = path + '[' + i + ']';
                objectKeys(item, ['expr', 'now'], itemPath);
                regex(item.expr, itemPath + '.expr');
                string(item.now, itemPath + '.now');
            });
            break;
        case 'Regex Delete Operator':
            regularExpressions(args, path);
            break;
        case 'Handle Duplicate Operator':
            objectKeys(args, ['action', 'template', 'link', 'position', 'field'], path);
            if (args.action != null && !['delete', 'rename'].includes(args.action)) {
                invalid('重复节点处理选项无效', path + '.action');
            }
            if (args.template != null) {
                string(args.template, path + '.template');
                if (args.template.split(' ').length !== 10) invalid('数字模板需要 10 个数字', path + '.template');
            }
            if (args.position != null && !['front', 'back'].includes(args.position)) {
                invalid('重复节点编号位置无效', path + '.position');
            }
            if (args.link != null) string(args.link, path + '.link');
            if (args.field != null) {
                strings(args.field, path + '.field', 16);
                args.field.forEach((field) => {
                    if (field.split(/[.\[\]]/).some((key) => forbiddenKeys.has(key))) {
                        invalid('重复节点属性无效', path + '.field');
                    }
                });
            }
            break;
    }
}

export function validateProcessors(items = [], path = 'process') {
    if (!Array.isArray(items) || items.length > 64) {
        invalid('处理动作必须是长度不超过 64 的数组', path);
    }
    items.forEach((item, index) => {
        const itemPath = path + '[' + index + ']';
        if (!plain(item) || !own(PROCESSORS, item.type)) {
            unsupported('当前基础版不支持处理动作：' + (item?.type ?? 'unknown'), itemPath + '.type');
        }
        objectKeys(item, ['type', 'args', 'disabled', 'customName', 'id'], itemPath);
        if (item.disabled != null && typeof item.disabled !== 'boolean') {
            invalid('disabled 必须是布尔值', itemPath + '.disabled');
        }
        if (item.customName != null) string(item.customName, itemPath + '.customName');
        const args = item.args ?? (item.type === 'Sort Operator' ? 'asc' : {});
        validateArgs(item.type, args, itemPath + '.args');
    });
    return items;
}

export function validateNodes(nodes, path = 'proxies') {
    nodes.forEach((node, index) => {
        const itemPath = path + '[' + index + ']';
        if (node.type === 'external') {
            unsupported('基础版不支持依赖本地进程的 external 节点', itemPath + '.type');
        }
        for (const field of [
            '_ca', 'ca', 'private-key-path', 'certificate-path', 'exec',
            '_mihomoExternal', '_localPort', '_merge', '_mergeName', '_exec', '_config',
        ]) {
            if (node[field]) unsupported('基础版不支持节点的本地文件／进程参数：' + field, itemPath + '.' + field);
        }
    });
}
