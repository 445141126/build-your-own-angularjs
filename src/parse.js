import _ from './utils'
import { filter } from './filter'
import { parse as AST } from './grammer'

export class ASTCompiler {
    constructor(astBuilder) {
        this.astBuilder = astBuilder
    }

    compile(text) {
        const ast = this.astBuilder.ast(text)
        markConstantAndWatchExpressions(ast)
        this.state = {
            body: [],
            nextId: 0,
            vars: [],
            fn: {body: [], var: []},
            filters: {}
        }
        this.recurse(ast)

        var fnString = this.filterPrefix() +
            'var fn=function(s,l){' + 
            (this.state.vars.length ? 
                'var ' + this.state.vars.join(',') + ';' :
                ''
            ) + 
            this.state.body.join(' ') + '}; return fn;'

        var fn = new Function(
            'ensureSafeMemberName',
            'ensureSafeObject',
            'ensureSafeFunction',
            'ifDefined',
            'filter',
             fnString)(
                 ensureSafeMemberName,
                 ensureSafeObject,
                 ensureSafeFunction,
                 ifDefined,
                 filter)
        fn.literal = isLiteral(ast)
        fn.constant = ast.constant
        return fn
    }

    recurse(ast, context, create) {
        var intoId
        switch(ast.type) {
        case AST.Program:
            _.forEach(_.initial(ast.body), (stmt) => {
                this.state.body.push(this.recurse(stmt), ';')
            })
            this.state.body.push('return ', this.recurse(_.last(ast.body)), ';')
            break
        case AST.Literal:
            return ast.value
        case AST.ArrayExpression:
            var elements = _.map(ast.elements, (e) => {
                return this.recurse(e)
            })
            return '[' + elements.join(',') + ']'
        case AST.ObjectExpression:
            var properties = _.map(ast.properties, (p) => {
                var key = p.key.type === AST.Identifier ?
                    p.key.name : p.key.value
                var value = this.recurse(p.value)
                return key + ':' + value
            })
            return '{' + properties.join(',') + '}'
        case AST.Identifier:
            ensureSafeMemberName(ast.name)
            intoId = this.nextId()
            this.if_(this.getHasOwnProperty('l', ast.name), 
                this.assign(intoId, this.nonComputedMember('l', ast.name)))
            if(create) {
                this.if_(this.not(this.getHasOwnProperty('l', ast.name)) + 
                        ' && s && ' + 
                        this.not(this.getHasOwnProperty('s', ast.name)), 
                    this.assign(this.nonComputedMember('s', ast.name), '{}'))
            }
            this.if_(this.not(this.getHasOwnProperty('l', ast.name)) + ' && s', 
                this.assign(intoId, this.nonComputedMember('s', ast.name)))
            if(context) {
                context.context = this.getHasOwnProperty('l', ast.name) + '?l:s'
                context.name = ast.name
                context.computed = false
            }
            this.addEnsureSafeObject(intoId)
            return intoId
        case AST.ThisExpression:
            return 's'
        case AST.MemberExpression:
            intoId = this.nextId()
            var left = this.recurse(ast.object, undefined, create)
            if(context) {
                context.context = left
            }
            if(ast.computed) {
                var right = this.recurse(ast.property)
                this.addEnsureSafeMemberName(right)
                if(create) {
                    this.if_(this.not(this.computedMember(left, right)), 
                        this.assign(this.computedMember(left, right), '{}'))
                }
                this.if_(left, 
                    this.assign(intoId, 
                        'ensureSafeObject(' + this.computedMember(left, right) + ')'))
                if(context) {
                    context.name = right
                    context.computed = true
                }
            } else {
                ensureSafeMemberName(ast.property.name)
                if(create) {
                    this.if_(this.not(this.nonComputedMember(left, ast.property.name)), 
                        this.assign(this.nonComputedMember(left, ast.property.name), '{}'))
                }
                this.if_(left, 
                    this.assign(intoId,
                        'ensureSafeObject(' +  
                            this.nonComputedMember(left, ast.property.name) + ')'))
                if(context) {
                    context.name = ast.property.name
                    context.computed = false
                }
            }
            return intoId
        case AST.CallExpression:
            var callContext, callee, args
            if(ast.filter) {
                callee = this.filter(ast.callee.name)
                args = _.map(ast.arguments, (arg) => {
                    return this.recurse(arg)
                })
                return callee + '(' + args + ')'
            }
            callContext = {}
            callee = this.recurse(ast.callee, callContext)
            args = _.map(ast.arguments, (arg) => {
                return 'ensureSafeObject(' + this.recurse(arg) + ')'
            })
            if(callContext.name) {
                this.addEnsureSafeObject(callContext.context)
                if(callContext.computed) {
                    callee = this.computedMember(callContext.context, callContext.name)
                } else {
                    callee = this.nonComputedMember(callContext.context, callContext.name)                    
                }
            }
            this.addEnsureSafeFunction(callee)
            return callee + '&& ensureSafeObject(' + callee + '(' + args.join(',') + '))'
        case AST.AssignmentExpression:
            var leftContext = {}
            this.recurse(ast.left, leftContext, true)
            var leftExpr
            if(leftContext.computed) {
                leftExpr = this.computedMember(leftContext.context, leftContext.name)
            } else {
                leftExpr = this.nonComputedMember(leftContext.context, leftContext.name)
            }
            return this.assign(leftExpr, 
                'ensureSafeObject(' + this.recurse(ast.right) + ')')
        case AST.UnaryExpression:
            return ast.operator + 
                '(' + this.ifDefined(this.recurse(ast.argument), 0) + ')'
        case AST.BinaryExpression:
            if(ast.operator === '+' || ast.operator === '-') {
                return '(' + this.ifDefined(this.recurse(ast.left), 0)+ ')' + 
                    ast.operator + 
                    '(' + this.ifDefined(this.recurse(ast.right), 0) + ')'
            } else {
                return '(' + this.recurse(ast.left) + ')' +
                    ast.operator + 
                    '(' + this.recurse(ast.right) + ')'
            }
        case AST.LogicalExpression:
            intoId = this.nextId()
            this.state.body.push(this.assign(intoId, this.recurse(ast.left)))
            this.if_(ast.operator === '&&' ? intoId : this.not(intoId), 
                this.assign(intoId, this.recurse(ast.right)))
            return intoId
        case AST.ConditionalExpression:
            intoId = this.nextId()
            var testId = this.nextId()
            this.state.body.push(this.assign(testId, this.recurse(ast.test)))
            this.if_(testId,
                this.assign(intoId, this.recurse(ast.consequent)))
            this.if_(this.not(testId),
                this.assign(intoId, this.recurse(ast.alternate)))
            return intoId
        }
    }

    nonComputedMember(left, right) {
        return '(' + left + ').' + right
    }

    computedMember(left, right) {
        return '(' + left + ')[' + right + ']'
    }

    if_(test, consequent) {
        this.state.body.push('if(', test, '){', consequent, '}')
    }

    assign(id, value) {
        return id + '=' + value + ';'
    }

    nextId(skip=false) {
        var id = 'v' + (this.state.nextId++)
        if(!skip) {
            this.state.vars.push(id)
        }
        return id
    }

    not(e) {
        return '!(' + e + ')'
    }

    getHasOwnProperty(object, property) {
        return object + '&&("' + property + '" in ' +  object + ')'
    }

    addEnsureSafeMemberName(expr) {
        this.state.body.push('ensureSafeMemberName(' + expr + ');')
    }

    addEnsureSafeObject(expr) {
        this.state.body.push('ensureSafeObject(' + expr + ');')
    }

    addEnsureSafeFunction(expr) {
        this.state.body.push('ensureSafeFunction(' + expr + ');')
    }

    ifDefined(value, defaultValue) {
        return 'ifDefined(' + value + ',' + defaultValue + ')'
    }

    filter(name) {
        if(!this.state.filters.hasOwnProperty(name)) {
            this.state.filters[name] = this.nextId(true)    
        }
        return this.state.filters[name]
    }

    filterPrefix() {
        if(_.isEmpty(this.state.filters)) {
            return ''
        } else {
            var parts = _.map(this.state.filters, (varName, filterName) => {
                return varName + '=' + 'filter("' + filterName + '")'
            })
            return 'var ' + parts.join(',') + ';'
        }
    }
}

function ensureSafeMemberName(name) {
    if(name === 'constructor' || name === '__proto__' ||
        name === '__defineGetter__' || name === '__defineSetter__' ||
        name === '__lookupGetter__' || name === '__lookupSetter__') {
        throw 'Attempting to access a disallowed field in Angular expressions!'
    }
}

function ensureSafeObject(obj) {
    if(obj) {
        if(obj.document && obj.location && obj.alert && obj.setInterval) {
            throw 'Referencing window in Angular expressions is disallowed'
        } else if (obj.children && 
                (obj.nodeName || (obj.prop && obj.attr && obj.find))) {
            throw 'Referencing DOM nodes in Angular expressions is disallowed'
        } else if(obj.constructor === obj) {
            throw 'Referencing Function in Angular expressions is disallowed'
        } else if(obj.getOwnPropertyNames || obj.getOwnPropertyDescriptor) {
            throw 'Referencing Object in Angular expressions is disallowed'            
        }
    }
    return obj
}

function ensureSafeFunction(obj) {
    var CALL = Function.prototype.call
    var BIND = Function.prototype.bind
    var APPLY = Function.prototype.apply
    if(obj) {
        if(obj.constructor === obj) {
            throw 'Referencing Function in Angular expressions is disallowed'            
        } else if(obj === CALL || obj === BIND || obj === APPLY) {
            throw 'Referencing call, apply, or bind in Angular expressions '+
                'is disallowed!'
        }
    }
}

function ifDefined(value, defaultValue) {
    return typeof value === 'undefined' ? defaultValue : value
}

function isLiteral(ast) {
    return ast.body.length === 0 ||
        ast.body.length === 1 && (
            ast.body[0].type === AST.Literal ||
            ast.body[0].type === AST.ArrayExpression ||
            ast.body[0].type === AST.ObjectExpression
        )
}

function markConstantAndWatchExpressions(ast) {
    var allConstants
    var argsToWatch
    switch(ast.type) {
    case AST.Program:
        allConstants = true
        _.forEach(ast.body, (expr) => {
            markConstantAndWatchExpressions(expr)
            allConstants = allConstants && expr.constant
        })
        ast.constant = allConstants
        break
    case AST.Literal:
        ast.constant = true
        ast.toWatch = []
        break
    case AST.Identifier:
        ast.constant = false
        ast.toWatch = [ast]
        break
    case AST.ArrayExpression:
        allConstants = true
        argsToWatch = []
        _.forEach(ast.elements, (element) => {
            markConstantAndWatchExpressions(element)
            allConstants = allConstants && element.constant
            if(!element.constant) {
                argsToWatch.push.apply(argsToWatch, element.toWatch)
            }
        })
        ast.constant = allConstants
        ast.toWatch = argsToWatch
        break
    case AST.ObjectExpression:
        allConstants = true
        argsToWatch = []
        _.forEach(ast.properties, (property) => {
            markConstantAndWatchExpressions(property.value)
            allConstants = allConstants && property.value.constant
            if(!property.value.constant) {
                argsToWatch.push.apply(argsToWatch, property.value.toWatch)
            }
        })
        ast.constant = allConstants
        ast.toWatch = argsToWatch
        break
    case AST.ThisExpression:
        ast.constant = false
        ast.toWatch = []
        break
    case AST.MemberExpression:
        markConstantAndWatchExpressions(ast.object)
        if(ast.computed) {
            markConstantAndWatchExpressions(ast.property)
        }
        ast.constant = ast.object.constant && (!ast.computed || ast.property.constant)
        ast.toWatch = [ast]
        break
    case AST.CallExpression:
        allConstants = !!ast.filter
        argsToWatch = []
        _.forEach(ast.arguments, (arg) => {
            markConstantAndWatchExpressions(arg)
            allConstants = allConstants && arg.constant
            if(!arg.constant) {
                argsToWatch.push.apply(argsToWatch, arg.toWatch)
            }
        })
        ast.constant = allConstants
        ast.toWatch = ast.filter ? argsToWatch : [ast]
        break
    case AST.AssignmentExpression:
        markConstantAndWatchExpressions(ast.left)
        markConstantAndWatchExpressions(ast.right)
        ast.constant = ast.left.constant && ast.right.constant
        ast.toWatch = [ast]
        break
    case AST.UnaryExpression:
        markConstantAndWatchExpressions(ast.argument)
        ast.constant = ast.argument.constant
        ast.toWatch = ast.argument.toWatch
        break
    case AST.BinaryExpression:
        markConstantAndWatchExpressions(ast.left)
        markConstantAndWatchExpressions(ast.right)
        ast.constant = ast.left.constant && ast.right.constant
        ast.toWatch = ast.left.toWatch.concat(ast.right.toWatch)
        break
    case AST.LogicalExpression:
        markConstantAndWatchExpressions(ast.left)
        markConstantAndWatchExpressions(ast.right)
        ast.constant = ast.left.constant && ast.right.constant
        ast.toWatch = [ast]
        break
    case AST.ConditionalExpression:
        markConstantAndWatchExpressions(ast.test)
        markConstantAndWatchExpressions(ast.consequent)
        markConstantAndWatchExpressions(ast.alternate)
        ast.constant =
            ast.test.constant && ast.consequent.constant && ast.alternate.constant
        ast.toWatch = [ast]
        break
    }
}

function constantWatchDelegate(scope, listenerFn, valueEq, watchFn) {
    var unwatch = scope.$watch(() => {
        return watchFn(scope)
    }, function() {
        if(_.isFunction(listenerFn)) {
            listenerFn.apply(this, arguments)
        }
        unwatch()
    }, valueEq)
    return unwatch
}

function oneTimeWatchDelegate(scope, listenerFn, valueEq, watchFn) {
    var lastValue
    var unwatch = scope.$watch(() => {
        return watchFn(scope)
    }, function(newValue, oldValue, scope) {
        lastValue = newValue
        if(_.isFunction(listenerFn)) {
            listenerFn.apply(this, arguments)
        }
        if(!_.isUndefined(newValue)) {
            scope.$$postDigest(() => {
                if(!_.isUndefined(lastValue)) {
                    unwatch()
                }
            })
        }
    }, valueEq)
    return unwatch    
}

function oneTimeLiteralWatchDelegate(scope, listenerFn, valueEq, watchFn) {
    function isAllDefined(val) {
        return !_.some(val, _.isUndefined)
    }
    var unwatch = scope.$watch(() => {
        return watchFn(scope)
    }, function(newValue, oldValue, scope) {
        if(_.isFunction(listenerFn)) {
            listenerFn.apply(this, arguments)
        }
        if(isAllDefined(newValue)) {
            scope.$$postDigest(() => {
                if(isAllDefined(newValue)) {
                    unwatch()
                }
            })
        }
    }, valueEq)
    return unwatch    
}

function inputsWatchDelegate(scope, listenerFn, valueEq, watchFn) {
    var inputExpressions = watchFn.inputs
    var oldValues = _.times(inputExpressions.length, _.constant(() => {}))
    var lastResult

    return scope.$watch(() => {
        var changed = false
        _.forEach(inputExpressions, (inputExpr, i) => {
            var newValue = inputExpr(scope)
            if(changed || !expressionInputDirtyCheck(newValue, oldValues[i])) {
                changed = true
                oldValues[i] = newValue
            }
        })
        if(changed) {
            lastResult = watchFn(scope)
        }
        return lastResult
    }, listenerFn, valueEq)
}

function expressionInputDirtyCheck(newValue, oldValue) {
    return newValue === oldValue ||
        (typeof newValue === 'number' && typeof oldValue === 'number' &&
        isNaN(newValue) && isNaN(oldValue))
}

export class Parser {
    constructor(lexer) {
        this.lexer = lexer
        this.ast = {ast: AST}
        this.astCompiler = new ASTCompiler(this.ast)
    }

    parse(text) {
        return this.astCompiler.compile(text)
    }
}

export function parse(expr) {
    switch(typeof expr) {
    case 'string':
        var parser = new Parser()
        var oneTime = false
        if(expr.charAt(0) == ':' && expr.charAt(1) == ':') {
            oneTime = true
            expr = expr.substring(2)
        }
        var parseFn = parser.parse(expr)
        if(parseFn.constant) {
            parseFn.$$watchDelegate = constantWatchDelegate
        } else if (oneTime) {
            parseFn.$$watchDelegate = parseFn.literal ? oneTimeLiteralWatchDelegate :
                                                        oneTimeWatchDelegate
        } else if (parseFn.inputs) {
            parseFn.$$watchDelegate = inputsWatchDelegate
        }
        return parseFn
    case 'function':
        return expr
    default:
        return _.noop
    }
}

export default parse