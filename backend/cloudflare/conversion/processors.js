// Pure built-in processors derived from Sub-Store 2.42.2 (AGPL-3.0).
// Dynamic scripts and DNS/remote/config processing are intentionally absent.
import lodash from 'lodash';
import { getFlag, removeFlag } from './geo.js';

function ConditionalFilter({ rule }) {
    return {
        name: 'Conditional Filter',
        func: (proxies) => {
            return proxies.map((proxy) => isMatch(rule, proxy));
        },
    };
}

function isMatch(rule, proxy) {
    // leaf node
    if (!rule.operator) {
        switch (rule.proposition) {
            case 'IN':
                return rule.value.indexOf(proxy[rule.attr]) !== -1;
            case 'CONTAINS':
                if (typeof proxy[rule.attr] !== 'string') return false;
                return proxy[rule.attr].indexOf(rule.value) !== -1;
            case 'EQUALS':
                return proxy[rule.attr] === rule.value;
            case 'EXISTS':
                return (
                    proxy[rule.attr] !== null &&
                    typeof proxy[rule.attr] !== 'undefined'
                );
            default:
                throw new Error(`Unknown proposition: ${rule.proposition}`);
        }
    }

    // operator nodes
    switch (rule.operator) {
        case 'AND':
            return rule.child.every((child) => isMatch(child, proxy));
        case 'OR':
            return rule.child.some((child) => isMatch(child, proxy));
        case 'NOT':
            return !isMatch(rule.child, proxy);
        default:
            throw new Error(`Unknown operator: ${rule.operator}`);
    }
}

function QuickSettingOperator(args) {
    return {
        name: 'Quick Setting Operator',
        func: (proxies) => {
            if (get(args.useless)) {
                const filter = UselessFilter();
                const selected = filter.func(proxies);
                proxies = proxies.filter(
                    (p, i) => selected[i] && p.port > 0 && p.port <= 65535,
                );
            }

            return proxies.map((proxy) => {
                proxy.udp = get(args.udp, proxy.udp);
                proxy.tfo = get(args.tfo, proxy.tfo);
                proxy['fast-open'] = get(args.tfo, proxy['fast-open']);
                proxy['skip-cert-verify'] = get(
                    args.scert,
                    proxy['skip-cert-verify'],
                );
                if (proxy.type === 'vmess') {
                    proxy.aead = get(args['vmess aead'], proxy.aead);
                }
                if (['snell', 'anytls', 'trusttunnel'].includes(proxy.type)) {
                    proxy.reuse = get(args.reuse, proxy.reuse);
                }
                if (['tuic', 'hysteria2'].includes(proxy.type)) {
                    proxy.ecn = get(args.ecn, proxy.ecn);
                }
                proxy['block-quic'] = getBlockQuic(
                    args['block-quic'],
                    proxy['block-quic'],
                );
                proxy['ip-version'] = getValue(
                    args['ip-version'],
                    proxy['ip-version'],
                );
                return proxy;
            });
        },
    };

    function get(value, defaultValue) {
        switch (value) {
            case 'ENABLED':
                return true;
            case 'DISABLED':
                return false;
            default:
                return defaultValue;
        }
    }

    function getBlockQuic(value, defaultValue) {
        switch (value) {
            case 'auto':
            case 'on':
            case 'off':
                return value;
            default:
                return defaultValue;
        }
    }

    function getValue(value, defaultValue) {
        switch (value) {
            case undefined:
            case null:
            case '':
            case 'DEFAULT':
                return defaultValue;
            default:
                return value;
        }
    }
}

// add or remove flag for proxies
function FlagOperator({ mode, tw }) {
    return {
        name: 'Flag Operator',
        func: (proxies) => {
            return proxies.map((proxy) => {
                if (mode === 'remove') {
                    // no flag
                    proxy.name = removeFlag(proxy.name);
                } else {
                    // get flag
                    const newFlag = getFlag(proxy.name);
                    // remove old flag
                    proxy.name = removeFlag(proxy.name);
                    proxy.name = newFlag + ' ' + proxy.name;
                    if (tw == 'ws') {
                        proxy.name = proxy.name.replace(/🇹🇼/g, '🇼🇸');
                    } else if (tw == 'tw') {
                        // 不变
                    } else {
                        proxy.name = proxy.name.replace(/🇹🇼/g, '🇨🇳');
                    }
                }
                return proxy;
            });
        },
    };
}

// duplicate handler
function HandleDuplicateOperator(arg) {
    const { action, template, link, position, field } = {
        ...{
            action: 'rename',
            template: '0 1 2 3 4 5 6 7 8 9',
            link: '-',
            position: 'back',
            field: ['name'],
        },
        ...arg,
    };
    return {
        name: 'Handle Duplicate Operator',
        func: (proxies) => {
            if (action === 'delete') {
                    const chosen = Object.create(null);
                return proxies.filter((p) => {
                    const key = field
                        .map((f) => lodash.get(p, f, '-'))
                        .join('_');
                    if (chosen[key]) {
                        return false;
                    }
                    chosen[key] = true;
                    return true;
                });
            } else if (action === 'rename') {
                const numbers = template.split(' ');
                // count occurrences of each name
                const counter = Object.create(null);
                let maxLen = 0;
                proxies.forEach((p) => {
                    const key = field
                        .map((f) => lodash.get(p, f, '-'))
                        .join('_');
                    if (typeof counter[key] === 'undefined') counter[key] = 1;
                    else counter[key]++;
                    maxLen = Math.max(counter[key].toString().length, maxLen);
                });
                const increment = Object.create(null);
                return proxies.map((p) => {
                    const key = field
                        .map((f) => lodash.get(p, f, '-'))
                        .join('_');
                    if (counter[key] > 1) {
                        if (typeof increment[key] == 'undefined')
                            increment[key] = 1;
                        let num = '';
                        let cnt = increment[key]++;
                        let numDigits = 0;
                        while (cnt > 0) {
                            num = numbers[cnt % 10] + num;
                            cnt = parseInt(cnt / 10);
                            numDigits++;
                        }
                        // padding
                        while (numDigits++ < maxLen) {
                            num = numbers[0] + num;
                        }
                        if (position === 'front') {
                            p.name = num + link + p.name;
                        } else if (position === 'back') {
                            p.name = p.name + link + num;
                        }
                    }
                    return p;
                });
            }
        },
    };
}

// sort proxies according to their names
function SortOperator(order = 'asc') {
    return {
        name: 'Sort Operator',
        func: (proxies) => {
            switch (order) {
                case 'asc':
                case 'desc':
                    return proxies.sort((a, b) => {
                        let res = a.name > b.name ? 1 : -1;
                        res *= order === 'desc' ? -1 : 1;
                        return res;
                    });
                case 'random':
                    return shuffle(proxies);
                default:
                    throw new Error('Unknown sort option: ' + order);
            }
        },
    };
}

// sort by regex
function RegexSortOperator(input) {
    const order = input.order || 'asc';
    let expressions = input.expressions;
    if (Array.isArray(input)) {
        expressions = input;
    }
    if (!Array.isArray(expressions)) {
        expressions = [];
    }
    return {
        name: 'Regex Sort Operator',
        func: (proxies) => {
            expressions = expressions.map((expr) => buildRegex(expr));
            return proxies.sort((a, b) => {
                const oA = getRegexOrder(expressions, a.name);
                const oB = getRegexOrder(expressions, b.name);
                if (oA && !oB) return -1;
                if (oB && !oA) return 1;
                if (oA && oB) return oA < oB ? -1 : 1;
                if (order === 'original') {
                    return 0;
                } else if (order === 'desc') {
                    return a.name < b.name ? 1 : -1;
                } else {
                    return a.name < b.name ? -1 : 1;
                }
            });
        },
    };
}

function getRegexOrder(expressions, str) {
    let order = null;
    for (let i = 0; i < expressions.length; i++) {
        if (expressions[i].test(str)) {
            order = i + 1; // plus 1 is important! 0 will be treated as false!!!
            break;
        }
    }
    return order;
}

// rename by regex
// keywords: [{expr: "string format regex", now: "now"}]
function RegexRenameOperator(regex) {
    return {
        name: 'Regex Rename Operator',
        func: (proxies) => {
            return proxies.map((proxy) => {
                for (const { expr, now } of regex) {
                    proxy.name = proxy.name
                        .replace(buildRegex(expr, 'g'), now)
                        .trim();
                }
                return proxy;
            });
        },
    };
}

// delete regex operator
// regex: ['a', 'b', 'c']
function RegexDeleteOperator(regex) {
    const regex_ = regex.map((r) => {
        return {
            expr: r,
            now: '',
        };
    });
    return {
        name: 'Regex Delete Operator',
        func: RegexRenameOperator(regex_).func,
    };
}

function isAscii(str) {
    // eslint-disable-next-line no-control-regex
    var pattern = /^[\x00-\x7F]+$/; // ASCII 范围的 Unicode 编码
    return pattern.test(str);
}

/**************************** Filters ***************************************/
// filter useless proxies
function UselessFilter() {
    return {
        name: 'Useless Filter',
        func: (proxies) => {
            return proxies.map((proxy) => {
                if (proxy.cipher && !isAscii(proxy.cipher)) {
                    return false;
                } else if (proxy.password && !isAscii(proxy.password)) {
                    return false;
                } else {
                    if (proxy.network) {
                        let transportHosts =
                            proxy[`${proxy.network}-opts`]?.headers?.Host ||
                            proxy[`${proxy.network}-opts`]?.headers?.host;
                        transportHosts = Array.isArray(transportHosts)
                            ? transportHosts
                            : [transportHosts];
                        if (
                            transportHosts.some(
                                (host) => host && !isAscii(host),
                            )
                        ) {
                            return false;
                        }
                    }
                    return !/网址|流量|时间|应急|过期|Bandwidth|expire/.test(
                        proxy.name,
                    );
                }
            });
        },
    };
}

// filter by regions
function RegionFilter(input) {
    let regions = input?.value || input;
    if (!Array.isArray(regions)) {
        regions = [];
    }
    const keep = input?.keep ?? true;
    const REGION_MAP = {
        HK: '🇭🇰',
        TW: '🇹🇼',
        US: '🇺🇸',
        SG: '🇸🇬',
        JP: '🇯🇵',
        UK: '🇬🇧',
        DE: '🇩🇪',
        KR: '🇰🇷',
    };
    return {
        name: 'Region Filter',
        func: (proxies) => {
            // this would be high memory usage
            return proxies.map((proxy) => {
                const flag = getFlag(proxy.name);
                const selected = regions.some((r) => REGION_MAP[r] === flag);
                return keep ? selected : !selected;
            });
        },
    };
}

// filter by regex
function RegexFilter({ regex = [], keep = true }) {
    return {
        name: 'Regex Filter',
        func: (proxies) => {
            return proxies.map((proxy) => {
                const selected = regex.some((r) => {
                    return buildRegex(r).test(proxy.name);
                });
                return keep ? selected : !selected;
            });
        },
    };
}

function buildRegex(str, ...options) {
    options = options.join('');
    if (str.startsWith('(?i)')) {
        str = str.substring(4);
        return new RegExp(str, 'i' + options);
    } else {
        return new RegExp(str, options);
    }
}

// filter by proxy types
function TypeFilter(input) {
    let types = input?.value || input;
    if (!Array.isArray(types)) {
        types = [];
    }
    const keep = input?.keep ?? true;
    return {
        name: 'Type Filter',
        func: (proxies) => {
            return proxies.map((proxy) => {
                const selected = types.some((t) => proxy.type === t);
                return keep ? selected : !selected;
            });
        },
    };
}

function shuffle(array) {
    let currentIndex = array.length,
        temporaryValue,
        randomIndex;

    // While there remain elements to shuffle...
    while (0 !== currentIndex) {
        // Pick a remaining element...
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex -= 1;

        // And swap it with the current element.
        temporaryValue = array[currentIndex];
        array[currentIndex] = array[randomIndex];
        array[randomIndex] = temporaryValue;
    }

    return array;
}

// deep clone object
function clone(object) {
    return JSON.parse(JSON.stringify(object));
}


export const PROCESSORS = Object.freeze({
    'Useless Filter': UselessFilter,
    'Region Filter': RegionFilter,
    'Regex Filter': RegexFilter,
    'Type Filter': TypeFilter,
    'Conditional Filter': ConditionalFilter,
    'Quick Setting Operator': QuickSettingOperator,
    'Flag Operator': FlagOperator,
    'Sort Operator': SortOperator,
    'Regex Sort Operator': RegexSortOperator,
    'Regex Rename Operator': RegexRenameOperator,
    'Regex Delete Operator': RegexDeleteOperator,
    'Handle Duplicate Operator': HandleDuplicateOperator,
});

